// src/test/suite/JsonStreamDecoder.test.ts
/**
 * JsonStreamDecoder 单测（纯 Node，不依赖 vscode 模块）。
 *
 * 覆盖：单帧、跨 chunk 边界（2/3 段拆分）、嵌套对象、字符串内花括号、
 * 转义引号 / 反斜杠（含跨 chunk）、连续多帧、JSON.parse 失败后宽松续扫、
 * reset() 清空状态、Buffer 与多字节 UTF-8 拆包。
 * 与 src/test/suite/extension.test.ts 同模板：Mocha TDD UI（suite / test 全局）。
 */
import * as assert from 'assert';

// 相对路径导入：tsc 编译后为 dist/test/suite -> dist/transport，
// 保证本用例可在纯 Node（npx mocha --ui tdd）下独立运行
import {JsonStreamDecoder} from '../../transport/JsonStreamDecoder';

/** 收集到的坏帧记录：错误对象 + 原始帧文本。 */
interface ErrorRecord {
  err: Error;
  raw: string;
}

/** 带事件收集器的解码器实例，供各用例断言。 */
interface DecoderCollector {
  decoder: JsonStreamDecoder;
  messages: object[];
  errors: ErrorRecord[];
}

/**
 * 创建一个挂好事件收集器的新解码器。
 * 每条用例独立实例，互不污染；且 'error' 始终有监听器，
 * 避免 Node 未处理 'error' 事件击穿测试进程。
 */
function collect(): DecoderCollector {
  const messages: object[] = [];
  const errors: ErrorRecord[] = [];
  const decoder = new JsonStreamDecoder();
  decoder.on('message', msg => messages.push(msg));
  decoder.on('error', (err, raw) => errors.push({err, raw}));
  return {decoder, messages, errors};
}

suite('JsonStreamDecoder', () => {
  suite('single frames', () => {
    test('decodes one complete JSON object from a single string push', () => {
      const {decoder, messages, errors} = collect();
      decoder.push('{"messageID":1,"scriptStates":[]}');
      assert.deepStrictEqual(messages, [{messageID: 1, scriptStates: []}]);
      assert.deepStrictEqual(errors, []);
    });

    test('decodes an empty object frame {}', () => {
      const {decoder, messages, errors} = collect();
      decoder.push('{}');
      assert.deepStrictEqual(messages, [{}]);
      assert.deepStrictEqual(errors, []);
    });

    test('accepts Buffer chunks', () => {
      const {decoder, messages, errors} = collect();
      decoder.push(Buffer.from('{"messageID":2}', 'utf8'));
      assert.deepStrictEqual(messages, [{messageID: 2}]);
      assert.deepStrictEqual(errors, []);
    });

    test('decodes a hub-shaped inbound message (messageID aligned with RxMsgType)', () => {
      const {decoder, messages, errors} = collect();
      decoder.push(
        '{"messageID":1,"savePath":"C:\\\\save.json",' +
          '"scriptStates":[{"name":"Global","guid":"-1","script":"print(1)"}]}'
      );
      assert.deepStrictEqual(messages, [
        {
          messageID: 1,
          savePath: 'C:\\save.json',
          scriptStates: [{name: 'Global', guid: '-1', script: 'print(1)'}],
        },
      ]);
      assert.deepStrictEqual(errors, []);
    });
  });

  suite('chunk boundaries', () => {
    test('decodes a frame split across 2 chunks', () => {
      const {decoder, messages, errors} = collect();
      decoder.push('{"mess');
      decoder.push('ageID":3}');
      assert.deepStrictEqual(messages, [{messageID: 3}]);
      assert.deepStrictEqual(errors, []);
    });

    test('decodes a frame split across 3 chunks', () => {
      const {decoder, messages, errors} = collect();
      decoder.push('{"id"');
      decoder.push(':42,"tag":"object"');
      decoder.push('}');
      assert.deepStrictEqual(messages, [{id: 42, tag: 'object'}]);
      assert.deepStrictEqual(errors, []);
    });

    test('keeps an unterminated string open across chunks', () => {
      const {decoder, messages, errors} = collect();
      decoder.push('{"msg":"abc');
      decoder.push('" }');
      assert.deepStrictEqual(messages, [{msg: 'abc'}]);
      assert.deepStrictEqual(errors, []);
    });

    test('handles multibyte UTF-8 characters split across Buffer chunks', () => {
      const {decoder, messages, errors} = collect();
      // "中" 占 3 字节（E4 B8 AD），两个拆分点均落在多字节字符内部；
      // 字符串内的 `}` 不得参与 brace 计数
      const buf = Buffer.from('{"msg":"中}文"}', 'utf8');
      decoder.push(buf.subarray(0, 9));
      decoder.push(buf.subarray(9, 13));
      decoder.push(buf.subarray(13));
      assert.deepStrictEqual(messages, [{msg: '中}文'}]);
      assert.deepStrictEqual(errors, []);
    });
  });

  suite('nesting and string literals', () => {
    test('decodes nested objects and arrays as one frame', () => {
      const {decoder, messages, errors} = collect();
      decoder.push('{"a":{"b":{"c":[1,2,{"d":null}]}}}');
      assert.deepStrictEqual(messages, [{a: {b: {c: [1, 2, {d: null}]}}}]);
      assert.deepStrictEqual(errors, []);
    });

    test('braces inside string literals do not affect the counter', () => {
      const {decoder, messages, errors} = collect();
      decoder.push('{"msg":"hello}world{"}');
      assert.deepStrictEqual(messages, [{msg: 'hello}world{'}]);
      assert.deepStrictEqual(errors, []);
    });

    test('escaped quotes inside strings do not close the string', () => {
      const {decoder, messages, errors} = collect();
      // 帧原文：{"msg":"say \"hi\" now"}
      decoder.push('{"msg":"say \\"hi\\" now"}');
      assert.deepStrictEqual(messages, [{msg: 'say "hi" now'}]);
      assert.deepStrictEqual(errors, []);
    });

    test('escaped quotes are handled across chunk boundaries', () => {
      const {decoder, messages, errors} = collect();
      // 第一段以孤立的反斜杠收尾（状态停在 InStringEscape），`\"` 的引号在第二段
      decoder.push('{"msg":"abc\\');
      decoder.push('"def"}');
      assert.deepStrictEqual(messages, [{msg: 'abc"def'}]);
      assert.deepStrictEqual(errors, []);
    });

    test('escaped backslashes inside strings are consumed as pairs', () => {
      const {decoder, messages, errors} = collect();
      // 帧原文：{"path":"C:\\Users\\test"}
      decoder.push('{"path":"C:\\\\Users\\\\test"}');
      assert.deepStrictEqual(messages, [{path: 'C:\\Users\\test'}]);
      assert.deepStrictEqual(errors, []);
    });

    test('string ending with an escaped backslash keeps its closing quote', () => {
      const {decoder, messages, errors} = collect();
      // 帧原文：{"a":"x\\"} —— `\\` 是转义的反斜杠，随后的 `"` 才真正闭合字符串
      decoder.push('{"a":"x\\\\"}');
      assert.deepStrictEqual(messages, [{a: 'x\\'}]);
      assert.deepStrictEqual(errors, []);
    });

    test('escaped brace inside string is skipped without counting', () => {
      const {decoder, messages, errors} = collect();
      // 帧原文：{"a":"\\{"} —— 转义的反斜杠 + 字符串内的 `{` 均不参与计数
      decoder.push('{"a":"\\\\{"}');
      assert.deepStrictEqual(messages, [{a: '\\{'}]);
      assert.deepStrictEqual(errors, []);
    });
  });

  suite('consecutive frames', () => {
    test('decodes consecutive frames concatenated without separators', () => {
      const {decoder, messages, errors} = collect();
      decoder.push('{"id":1}{"id":2}{"id":3}');
      assert.deepStrictEqual(messages, [{id: 1}, {id: 2}, {id: 3}]);
      assert.deepStrictEqual(errors, []);
    });

    test('decodes frames spread across multiple pushes', () => {
      const {decoder, messages, errors} = collect();
      decoder.push('{"id":1}');
      decoder.push('{"id":2}');
      decoder.push('{"id":3}');
      assert.deepStrictEqual(messages, [{id: 1}, {id: 2}, {id: 3}]);
      assert.deepStrictEqual(errors, []);
    });

    test('ignores noise between frames (lenient scanning)', () => {
      const {decoder, messages, errors} = collect();
      decoder.push('noise{"a":1},,]]{"b":2}trailing');
      assert.deepStrictEqual(messages, [{a: 1}, {b: 2}]);
      assert.deepStrictEqual(errors, []);
    });

    test('does not emit anything for a lone "{" until it is closed', () => {
      const {decoder, messages} = collect();
      decoder.push('{');
      assert.deepStrictEqual(messages, []);
      decoder.push('}');
      assert.deepStrictEqual(messages, [{}]);
    });
  });

  suite('lenient error recovery', () => {
    test('emits error with the raw frame when JSON.parse fails, then keeps scanning', () => {
      const {decoder, messages, errors} = collect();
      decoder.push('{"bad": }{"ok":1}');
      assert.strictEqual(errors.length, 1);
      assert.ok(errors[0].err instanceof Error);
      assert.strictEqual(errors[0].raw, '{"bad": }');
      assert.deepStrictEqual(messages, [{ok: 1}]);
    });

    test('recovers after several bad frames in a row', () => {
      const {decoder, messages, errors} = collect();
      decoder.push('{"x":}{"y":}{"z":3}');
      assert.strictEqual(errors.length, 2);
      assert.strictEqual(errors[0].raw, '{"x":}');
      assert.strictEqual(errors[1].raw, '{"y":}');
      assert.deepStrictEqual(messages, [{z: 3}]);
    });

    test('skips braces inside strings even in a frame that fails to parse', () => {
      const {decoder, messages, errors} = collect();
      // 帧原文：{"a":"}","b":} —— 字符串里的 `}` 不参与计数，帧终止于最后一个 `}`
      decoder.push('{"a":"}","b":}');
      assert.strictEqual(errors.length, 1);
      assert.strictEqual(errors[0].raw, '{"a":"}","b":}');
      assert.deepStrictEqual(messages, []);
    });
  });

  suite('reset', () => {
    test('reset() clears pending state for reconnect', () => {
      const {decoder, messages, errors} = collect();
      // 半帧卡在字符串内部（前面还带着帧外噪声前缀）
      decoder.push('garbage{"a":"open string');
      decoder.push('still inside \\"');
      // 重连后重置，随后只应收到新帧
      decoder.reset();
      decoder.push('{"fresh":true}');
      assert.deepStrictEqual(messages, [{fresh: true}]);
      assert.deepStrictEqual(errors, []);
    });

    test('reset() clears the mid-escape state', () => {
      const {decoder, messages, errors} = collect();
      // 帧尾是孤立的反斜杠 → 状态停在 InStringEscape
      decoder.push('{"a":"x\\');
      decoder.reset();
      // 若未重置，后续输入会被误认为仍在字符串内而永远无法成帧
      decoder.push('{"z":9}');
      assert.deepStrictEqual(messages, [{z: 9}]);
      assert.deepStrictEqual(errors, []);
    });
  });
});
