/**
 * 迷你世界核心逻辑测试：地形生成、方块读写、面剔除网格化、DDA 拾取、存档往返。
 * 运行：node test/minecraft-core.test.js
 */
'use strict';

const assert = require('assert');
const MC = require('../public/js/minecraft/core.js');

// ---- 地形确定性：同种子两次生成完全一致 ----
{
  const a = MC.createWorld(42);
  const b = MC.createWorld(42);
  assert.deepStrictEqual(a.data, b.data, '同种子应生成完全一致的世界');
  const c = MC.createWorld(43);
  assert.notDeepStrictEqual(a.data, c.data, '不同种子世界应不同');
}

// ---- 地形基本性质 ----
{
  const w = MC.createWorld(7);
  let hasWater = false, hasLog = false, hasLeaves = false, hasGrass = false;
  for (let x = 0; x < MC.SIZE_X; x++) {
    for (let z = 0; z < MC.SIZE_Z; z++) {
      assert.strictEqual(MC.getBlock(w, x, 0, z), MC.BEDROCK, 'y=0 必须是基岩');
      // 水面以上不允许出现悬空的「柱中水」：水只能出现在 WATER_LEVEL 及以下
      for (let y = MC.WATER_LEVEL + 1; y < MC.SIZE_Y; y++) {
        assert.notStrictEqual(MC.getBlock(w, x, y, z), MC.WATER, '水不应高于水面线');
      }
      // 从顶部向下第一个实体方块就是地表
      for (let y = MC.SIZE_Y - 1; y >= 0; y--) {
        const id = MC.getBlock(w, x, y, z);
        if (id === MC.AIR || id === MC.WATER) continue;
        const h = MC.heightAt(w.seed, x, z);
        assert.ok(y <= h + 8, '地表（含树冠外沿）不应高出地形高度太多');
        break;
      }
    }
  }
  for (let i = 0; i < w.data.length; i++) {
    const id = w.data[i];
    if (id === MC.WATER) hasWater = true;
    if (id === MC.LOG) hasLog = true;
    if (id === MC.LEAVES) hasLeaves = true;
    if (id === MC.GRASS) hasGrass = true;
  }
  assert.ok(hasGrass, '应有草方块');
  assert.ok(hasLog && hasLeaves, '应有树（木头与树叶）');
  // 水不做强制要求（理论上可能无洼地），但种子 7 应当有
  assert.ok(hasWater, '该种子应有湖泊');
}

// ---- 方块读写与边界 ----
{
  const w = MC.createWorld(1);
  assert.strictEqual(MC.getBlock(w, -1, 5, 5), MC.AIR, '水平越界是空气');
  assert.strictEqual(MC.getBlock(w, 5, MC.SIZE_Y + 1, 5), MC.AIR, '天上是空气');
  assert.strictEqual(MC.getBlock(w, 5, -1, 5), MC.BEDROCK, '地下是基岩');
  assert.strictEqual(MC.setBlock(w, 3, 30, 3, MC.STONE), true);
  assert.strictEqual(MC.getBlock(w, 3, 30, 3), MC.STONE);
  assert.strictEqual(MC.setBlock(w, -1, 30, 3, MC.STONE), false, '越界写入应失败');
  assert.strictEqual(MC.setBlock(w, 3, 0, 3, MC.AIR), false, '基岩不可破坏');
  assert.strictEqual(MC.getBlock(w, 3, 0, 3), MC.BEDROCK);
}

// ---- 网格化：孤立方块 6 面全暴露；相邻实体互相剔除 ----
{
  const w = { seed: 0, data: new Uint8Array(MC.SIZE_X * MC.SIZE_Y * MC.SIZE_Z) };
  MC.setBlock(w, 5, 30, 5, MC.STONE);
  let g = MC.buildChunkGeometry(w, 0, 0);
  assert.strictEqual(g.solid.positions.length / 3, 6 * 4, '孤立方块应有 6 面 × 4 顶点');
  assert.strictEqual(g.solid.indices.length, 6 * 6, '孤立方块应有 6 面 × 6 索引');
  assert.strictEqual(g.water.indices.length, 0, '无水的区块不应有水体网格');

  MC.setBlock(w, 6, 30, 5, MC.STONE); // 紧挨着的第二块
  g = MC.buildChunkGeometry(w, 0, 0);
  assert.strictEqual(g.solid.positions.length / 3, 10 * 4, '两块相邻应剔除 2 个贴合面');
}

// ---- 网格化：实体邻接水时画实体面、不画面重叠的水面 ----
{
  const w = { seed: 0, data: new Uint8Array(MC.SIZE_X * MC.SIZE_Y * MC.SIZE_Z) };
  MC.setBlock(w, 5, 30, 5, MC.STONE);
  MC.setBlock(w, 5, 31, 5, MC.WATER);
  const g = MC.buildChunkGeometry(w, 0, 0);
  assert.strictEqual(g.solid.positions.length / 3, 6 * 4, '石头 6 面全画（含贴水的一面）');
  assert.strictEqual(g.water.positions.length / 3, 5 * 4, '水贴着石头的那面不画');
}

// ---- DDA 拾取 ----
{
  const w = { seed: 0, data: new Uint8Array(MC.SIZE_X * MC.SIZE_Y * MC.SIZE_Z) };
  MC.setBlock(w, 10, 10, 10, MC.STONE);
  // 从正上方向下打
  const hit = MC.raycast(w, 10.5, 20, 10.5, 0, -1, 0, 10);
  assert.ok(hit, '应命中');
  assert.deepStrictEqual([hit.x, hit.y, hit.z], [10, 10, 10]);
  assert.deepStrictEqual([hit.nx, hit.ny, hit.nz], [0, 1, 0], '应从顶面命中');
  // 距离不够
  assert.strictEqual(MC.raycast(w, 10.5, 20, 10.5, 0, -1, 0, 5), null, '超出距离应未命中');
  // 水不算命中，直接穿过
  MC.setBlock(w, 10, 15, 10, MC.WATER);
  const hit2 = MC.raycast(w, 10.5, 20, 10.5, 0, -1, 0, 10);
  assert.strictEqual(hit2.id, MC.STONE, '射线应穿过水命中石头');
}

// ---- 存档往返 ----
{
  const w = MC.createWorld(99);
  MC.setBlock(w, 1, 40, 1, MC.PLANKS);
  MC.setBlock(w, 50, 30, 50, MC.AIR); // 挖个洞
  const str = MC.encodeWorld(w);
  const back = MC.decodeWorld(w.seed, str);
  assert.strictEqual(back.seed, w.seed);
  assert.deepStrictEqual(back.data, w.data, '编码解码后数据应一致');
  // 坏数据应报错而不是静默
  assert.throws(() => MC.decodeWorld(1, str.slice(0, -4) + 'AAAA'), /存档/, '损坏存档应抛错');
}

// ---- 出生点：落在实体地表上，不在水里 ----
{
  const w = MC.createWorld(2024);
  const s = MC.findSpawn(w);
  const below = MC.getBlock(w, Math.floor(s.x), Math.floor(s.y) - 1, Math.floor(s.z));
  assert.ok(MC.isOpaque(below), '出生点脚下应是实体');
  assert.notStrictEqual(below, MC.WATER, '出生点不应泡在水里');
}

// ---- 挖掘规则：硬度、工具加速、镐子限定掉落 ----
{
  assert.strictEqual(MC.digSeconds(MC.BEDROCK, 0), Infinity, '基岩挖不动');
  assert.ok(MC.digSeconds(MC.LEAVES, 0) < 0.5, '树叶秒挖');
  assert.strictEqual(MC.digSeconds(MC.STONE, 0), 3, '徒手挖石头慢');
  assert.strictEqual(MC.digSeconds(MC.STONE, MC.WOOD_PICK), 1, '木镐加速');
  assert.strictEqual(MC.digSeconds(MC.STONE, MC.STONE_PICK), 0.5, '石镐更快');
  assert.strictEqual(MC.digSeconds(MC.STONE, MC.WOOD_SWORD), 3, '剑不能当镐用');
  assert.strictEqual(MC.dropFor(MC.STONE, 0), 0, '徒手挖石头无掉落');
  assert.strictEqual(MC.dropFor(MC.STONE, MC.WOOD_PICK), MC.COBBLE, '镐挖石头掉圆石');
  assert.strictEqual(MC.dropFor(MC.COAL_ORE, MC.STONE_PICK), MC.COAL, '镐挖煤矿掉煤炭');
  assert.strictEqual(MC.dropFor(MC.COAL_ORE, 0), 0, '徒手挖煤矿无掉落');
  assert.strictEqual(MC.dropFor(MC.GRASS, 0), MC.DIRT, '草方块掉泥土');
  assert.strictEqual(MC.dropFor(MC.LEAVES, 0), 0, '树叶无掉落');
  assert.ok(MC.attackDamage(0) < MC.attackDamage(MC.WOOD_SWORD), '剑比手疼');
  assert.ok(MC.attackDamage(MC.STONE_SWORD) > MC.attackDamage(MC.WOOD_SWORD), '石剑强于木剑');
}

// ---- 背包：堆放、扣除、交换 ----
{
  const inv = MC.createInventory();
  assert.strictEqual(MC.addItem(inv, MC.STONE, 5), 0);
  assert.strictEqual(MC.countItem(inv, MC.STONE), 5);
  assert.deepStrictEqual(inv[0], { id: MC.STONE, n: 5 });
  MC.addItem(inv, MC.STONE, 3); // 叠加到已有堆
  assert.strictEqual(inv[0].n, 8);
  assert.strictEqual(MC.addItem(inv, MC.LOG, MC.STACK_MAX + 5), 0, '应能全部放下');
  assert.strictEqual(MC.countItem(inv, MC.LOG), MC.STACK_MAX + 5);
  assert.strictEqual(MC.removeItems(inv, MC.STONE, 8), true);
  assert.strictEqual(inv[0], null, '扣完后格子清空');
  assert.strictEqual(MC.removeItems(inv, MC.STONE, 1), false, '不足时失败且不动');
  inv[0] = { id: MC.DIRT, n: 2 }; inv[1] = { id: MC.SAND, n: 1 };
  MC.swapSlots(inv, 0, 1);
  assert.strictEqual(inv[0].id, MC.SAND);
  inv[2] = { id: MC.SAND, n: 3 };
  MC.swapSlots(inv, 0, 2); // 同类合并
  assert.deepStrictEqual(inv[2], { id: MC.SAND, n: 4 });
  assert.strictEqual(inv[0], null);
}

// ---- 合成：无序配方、材料检查、产物入包 ----
{
  const inv = MC.createInventory();
  const planksRecipe = MC.RECIPES.find((r) => r.out.id === MC.PLANKS);
  const stickRecipe = MC.RECIPES.find((r) => r.out.id === MC.STICK);
  const torchRecipe = MC.RECIPES.find((r) => r.out.id === MC.TORCH);
  const stonePickRecipe = MC.RECIPES.find((r) => r.out.id === MC.STONE_PICK);
  assert.strictEqual(MC.canCraft(inv, planksRecipe), false, '空背包不能合成');
  MC.addItem(inv, MC.LOG, 2);
  assert.strictEqual(MC.craft(inv, planksRecipe), true);
  assert.strictEqual(MC.countItem(inv, MC.PLANKS), 4);
  assert.strictEqual(MC.countItem(inv, MC.LOG), 1);
  assert.strictEqual(MC.craft(inv, stickRecipe), true);
  assert.strictEqual(MC.countItem(inv, MC.STICK), 4);
  assert.strictEqual(MC.canCraft(inv, stonePickRecipe), false, '没圆石不能合石镐');
  MC.addItem(inv, MC.COBBLE, 3);
  assert.strictEqual(MC.craft(inv, stonePickRecipe), true);
  assert.strictEqual(MC.countItem(inv, MC.STONE_PICK), 1);
  assert.strictEqual(MC.countItem(inv, MC.STICK), 2, '石镐消耗了 2 根木棍');
  MC.addItem(inv, MC.COAL, 1);
  assert.strictEqual(MC.craft(inv, torchRecipe), true);
  assert.strictEqual(MC.countItem(inv, MC.TORCH), 4);
}

// ---- 昼夜：状态连续、夜晚判定 ----
{
  const noon = MC.skyState(6000);
  const midnight = MC.skyState(18000);
  assert.ok(noon.dayFactor > 0.95, '正午大白天');
  assert.strictEqual(midnight.dayFactor, 0, '午夜全黑');
  assert.ok(MC.skyState(19000).night, '深夜刷怪');
  assert.ok(!MC.skyState(8000).night, '上午不刷怪');
  // 平滑过渡：相邻时刻亮度差不大
  for (let t = 0; t < MC.DAY_TICKS; t += 100) {
    const d = Math.abs(MC.skyState(t).dayFactor - MC.skyState(t + 100).dayFactor);
    assert.ok(d < 0.2, '昼夜过渡应平滑');
  }
}

// ---- 刷怪选址：脚下实体、头顶通透、不在水里 ----
{
  const w = MC.createWorld(2024);
  const spawn = MC.findSpawn(w);
  let ok = 0;
  const rng = (() => { let s = 1; return () => (s = (s * 1103515245 + 12345) & 0x7fffffff) / 0x7fffffff; })();
  for (let i = 0; i < 50 && ok < 5; i++) {
    const p = MC.findMobSpawn(w, spawn.x, spawn.z, rng);
    if (!p) continue;
    const bx = Math.floor(p.x), by = Math.floor(p.y), bz = Math.floor(p.z);
    assert.ok(MC.isOpaque(MC.getBlock(w, bx, by - 1, bz)), '脚下是实体');
    assert.strictEqual(MC.getBlock(w, bx, by, bz), MC.AIR, '身体处是空气');
    assert.strictEqual(MC.getBlock(w, bx, by + 1, bz), MC.AIR, '头顶是空气');
    const dx = p.x - spawn.x, dz = p.z - spawn.z;
    assert.ok(Math.hypot(dx, dz) >= 13, '不会刷在玩家脸上');
    ok++;
  }
  assert.ok(ok >= 5, '应能找到合法刷怪点');
}

// ---- 煤矿石确实生成在地层里 ----
{
  const w = MC.createWorld(42);
  let coal = 0;
  for (let i = 0; i < w.data.length; i++) if (w.data[i] === MC.COAL_ORE) coal++;
  assert.ok(coal > 50, '地层里应有煤矿石（实际 ' + coal + '）');
}

console.log('✔ 迷你世界核心逻辑测试全部通过');
