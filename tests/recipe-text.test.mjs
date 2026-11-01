import { test } from 'node:test';
import assert from 'node:assert/strict';
import { scaleText, formatAmount, firstAmount, parseUserAmount, parseRecipeText } from '../js/recipe-text.js';

const scaled = (text, ratio, mode) => scaleText(text, ratio, mode).map((p) => p.text).join('');

test('材料の分量を倍にする', () => {
  assert.equal(scaled('キャベツ 1/4玉', 2), 'キャベツ 1/2玉');
  assert.equal(scaled('鶏むね肉 300g', 1.5), '鶏むね肉 450g');
  assert.equal(scaled('醤油 大さじ1', 1.5), '醤油 大さじ1と1/2');
  assert.equal(scaled('砂糖 小さじ1/2', 2), '砂糖 小さじ1');
  assert.equal(scaled('卵 2個', 0.5), '卵 1個');
  assert.equal(scaled('水 200ml', 0.5), '水 100ml');
  assert.equal(scaled('じゃがいも 2〜3個', 2), 'じゃがいも 4〜6個');
  assert.equal(scaled('ごま油 大さじ１', 3), 'ごま油 大さじ3');
});

test('分量でないものは変えない', () => {
  assert.equal(scaled('塩 少々', 2), '塩 少々');
  assert.equal(scaled('A 醤油 大さじ1', 2), 'A 醤油 大さじ2');
  assert.equal(scaled('レンジ600Wで3分加熱する', 2, 'step'), 'レンジ600Wで3分加熱する');
  assert.equal(scaled('1cm幅に切る', 2, 'step'), '1cm幅に切る');
  assert.equal(scaled('水200mlと醤油大さじ2を加える', 0.5, 'step'), '水100mlと醤油大さじ1を加える');
  assert.equal(scaled('180℃のオーブンで20分', 2, 'step'), '180℃のオーブンで20分');
});

test('読みやすい表記', () => {
  assert.equal(formatAmount(233.3, 'g'), '235');
  assert.equal(formatAmount(1 / 3, '大さじ'), '1/3');
  assert.equal(formatAmount(0.37, '小さじ'), '1/3');
  assert.equal(formatAmount(0.42, '小さじ'), '0.4');
  assert.equal(formatAmount(2.5, '個'), '2と1/2');
  assert.equal(formatAmount(0.98, '本'), '1');
});

test('基準の量の取り出しと入力の解釈', () => {
  assert.deepEqual(firstAmount('鶏むね肉 300g'), { value: 300, unit: 'g', prefix: false, raw: '300' });
  assert.equal(firstAmount('醤油 大さじ1と1/2').value, 1.5);
  assert.equal(firstAmount('塩 少々'), null);
  assert.equal(parseUserAmount('450g'), 450);
  assert.equal(parseUserAmount('１と1/2'), 1.5);
  assert.ok(Number.isNaN(parseUserAmount('たくさん')));
});

test('見出し付きのInstagram投稿を振り分ける', () => {
  const caption = `【レンジで5分】やみつき無限キャベツ🥬
包丁いらずで簡単です！

＜材料（2人分）＞
・キャベツ…1/4玉
・鶏ガラスープの素：小さじ1
・ごま油 大さじ1

＜作り方＞
①キャベツをちぎって耐熱容器に入れる
②ラップをしてレンジ600Wで3分
③調味料を和える

ポイント💡
冷蔵で2日もちます

#無限キャベツ #時短レシピ #副菜
https://www.instagram.com/p/abc/`;
  const r = parseRecipeText(caption);
  assert.equal(r.title, '【レンジで5分】やみつき無限キャベツ');
  assert.equal(r.servings, 2);
  assert.equal(r.ingredients, 'キャベツ 1/4玉\n鶏ガラスープの素 小さじ1\nごま油 大さじ1');
  assert.equal(r.steps, 'キャベツをちぎって耐熱容器に入れる\nラップをしてレンジ600Wで3分\n調味料を和える');
  assert.match(r.memo, /包丁いらず/);
  assert.match(r.memo, /冷蔵で2日/);
  assert.deepEqual(r.tags, ['無限キャベツ', '時短レシピ', '副菜']);
  assert.equal(r.url, 'https://www.instagram.com/p/abc/');
});

test('見出しのないXの投稿も推測で振り分ける', () => {
  const post = `鶏むねのやわらか焼き、パサパサにならない！
鶏むね肉 300g
片栗粉 大さじ1
塩 少々
1. 鶏むねをそぎ切りにする
2. 片栗粉をまぶして焼く`;
  const r = parseRecipeText(post);
  assert.equal(r.title, '鶏むねのやわらか焼き、パサパサにならない！');
  assert.equal(r.ingredients, '鶏むね肉 300g\n片栗粉 大さじ1\n塩 少々');
  assert.equal(r.steps, '鶏むねをそぎ切りにする\n片栗粉をまぶして焼く');
});

test('材料の直後に番号付き手順が続く場合', () => {
  const r = parseRecipeText('豚こま炒め\n材料\n豚こま 200g\n玉ねぎ 1/2個\n1 玉ねぎを切る\n2 炒める');
  assert.equal(r.ingredients, '豚こま 200g\n玉ねぎ 1/2個');
  assert.equal(r.steps, '玉ねぎを切る\n炒める');
});

test('倍率1でも分量の位置に印が付く', () => {
  const parts = scaleText('鶏むね肉 300g', 1);
  assert.deepEqual(parts.map((p) => [p.text, !!p.amount]), [['鶏むね肉 ', false], ['300', true], ['g', false]]);
  assert.equal(scaleText('塩 少々', 1).some((p) => p.amount), false);
});
