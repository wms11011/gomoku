/** 房间领域逻辑（room-ops.js）单元测试：离线标记、座位保留、惰性清扫、补位 */
'use strict';

const assert = require('assert');
const ops = require('../server/room-ops.js');

// ---- 建房：初始在线状态 ----
{
  const room = ops.createRoomObj('TEST', 'alice');
  assert.strictEqual(room.black, 'alice');
  assert.strictEqual(room.blackOnline, true, '创建者初始在线');
  assert.strictEqual(room.whiteOnline, false);
}

// ---- 掉线：座位保留并标记离线；重连恢复 ----
{
  const room = ops.createRoomObj('TEST', 'alice');
  ops.applyJoin(room, 'bob');
  ops.applyDisconnect(room, 'alice');
  assert.strictEqual(room.black, 'alice', '掉线后黑座位仍保留');
  assert.strictEqual(room.blackOnline, false, '黑标记为离线');
  const out = ops.applyJoin(room, 'alice');
  assert.strictEqual(out.resumed, true, '原 cid 重连为恢复');
  assert.strictEqual(room.blackOnline, true, '恢复后重新在线');
}

// ---- 宽限期内第三方无法占座；超时后座位被清扫可占 ----
{
  const room = ops.createRoomObj('TEST', 'alice');
  ops.applyJoin(room, 'bob');
  ops.applyDisconnect(room, 'alice');
  const denied = ops.applyJoin(room, 'carol');
  assert.strictEqual(denied.err, '房间已满', '宽限期内座位被保留，第三方无法加入');

  // 未到宽限期：清扫不清座
  assert.strictEqual(ops.sweepOffline(room, Date.now()), false);
  assert.strictEqual(room.black, 'alice');

  // 超过宽限期：座位被清出，第三方可补位（包括补黑位）
  const later = Date.now() + ops.OFFLINE_GRACE + 1000;
  assert.strictEqual(ops.sweepOffline(room, later), true);
  assert.strictEqual(room.black, null);
  const ok = ops.applyJoin(room, 'carol');
  assert.ok(!ok.err && !ok.resumed, '超时清扫后第三方可补位');
  assert.strictEqual(room.black, 'carol', '补的是黑位');
}

// ---- 主动离开：立即让出座位；双方都走删房间 ----
{
  const room = ops.createRoomObj('TEST', 'alice');
  ops.applyJoin(room, 'bob');
  let out = ops.applyLeave(room, 'alice');
  assert.strictEqual(room.black, null, '主动离开立即让出黑位');
  assert.ok(!out.delete, '还剩白方，房间保留');
  out = ops.applyLeave(room, 'bob');
  assert.strictEqual(out.delete, true, '双方都离开应销毁房间');
}

// ---- 快照包含在线状态 ----
{
  const room = ops.createRoomObj('TEST', 'alice');
  ops.applyJoin(room, 'bob');
  ops.applyDisconnect(room, 'bob');
  const snapA = ops.snapshot(room, 'alice');
  assert.deepStrictEqual(snapA.players, { black: true, white: true }, '座位占用不变');
  assert.deepStrictEqual(snapA.online, { black: true, white: false }, '在线状态准确');
}

console.log('✔ 房间逻辑（离线/恢复/清扫/补位）测试全部通过');
