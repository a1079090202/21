/** 到期分档 + 告警判定（纯函数） */

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { tierForDaysLeft } from '../src/expiry.js';
import { decideAlert } from '../src/alerts.js';

test('分档：>30 天不告警', () => {
  assert.equal(tierForDaysLeft(31), null);
  assert.equal(tierForDaysLeft(100), null);
});

test('分档：30 天档边界', () => {
  assert.equal(tierForDaysLeft(30), 30);
  assert.equal(tierForDaysLeft(29), 30);
  assert.equal(tierForDaysLeft(15), 30);
});

test('分档：14 天档边界', () => {
  assert.equal(tierForDaysLeft(14), 14);
  assert.equal(tierForDaysLeft(13), 14);
  assert.equal(tierForDaysLeft(8), 14);
});

test('分档：7 天档边界，含当天和已过期', () => {
  assert.equal(tierForDaysLeft(7), 7);
  assert.equal(tierForDaysLeft(1), 7);
  assert.equal(tierForDaysLeft(0), 7);
  assert.equal(tierForDaysLeft(-3), 7);
});

test('判定：档外不告警', () => {
  const d = decideAlert(40, [], false);
  assert.equal(d.shouldCreate, false);
  assert.equal(d.tier, null);
  assert.equal(d.reason, 'none');
});

test('判定：命中档位且无未确认告警 → 记一条', () => {
  const d = decideAlert(5, [], false);
  assert.equal(d.shouldCreate, true);
  assert.equal(d.tier, 7);
  assert.equal(d.reason, 'create');
});

test('判定：同档已有未确认告警 → 不重复记', () => {
  const d = decideAlert(5, [7], false);
  assert.equal(d.shouldCreate, false);
  assert.equal(d.reason, 'duplicate');
});

test('判定：未确认的是别的档位，不拦截当前档', () => {
  const d = decideAlert(5, [14], false);
  assert.equal(d.shouldCreate, true);
  assert.equal(d.tier, 7);
});

test('判定：静默期内不新增告警，但档位照常计算', () => {
  const d = decideAlert(5, [], true);
  assert.equal(d.shouldCreate, false);
  assert.equal(d.tier, 7);
  assert.equal(d.reason, 'silenced');
});
