/**
 * 写入 5 条样例数据（域名 3 条 + 证书 2 条），到期日相对今天计算，
 * 覆盖 7/14/30 天档和档外。已录入过同名项会自动跳过，可重复执行。
 */

import { openDb } from './db.js';
import { addItem, listItems } from './repo.js';
import { addDays, shanghaiDate } from './time.js';

const db = openDb();
const now = Date.now();
const today = shanghaiDate(now);

const samples = [
  { kind: 'domain', name: 'finance.example.cn', registrar: '阿里云', expiresOn: addDays(today, 5), note: '财务系统域名' },
  { kind: 'domain', name: 'www.example.cn', registrar: '腾讯云', expiresOn: addDays(today, 10), note: '官网' },
  { kind: 'domain', name: 'api.example.cn', registrar: '华为云', expiresOn: addDays(today, 25), note: '开放接口' },
  { kind: 'cert', name: 'finance-tls', issuedTo: 'finance.example.cn', expiresOn: addDays(today, 6), note: '财务系统 TLS 证书' },
  { kind: 'cert', name: 'wildcard-example', issuedTo: '*.example.cn', expiresOn: addDays(today, 40), note: '泛域名证书' },
] as const;

const existing = new Set(listItems(db).map((i) => `${i.kind}:${i.name}`));
let inserted = 0;
for (const s of samples) {
  if (existing.has(`${s.kind}:${s.name}`)) continue;
  addItem(db, {
    kind: s.kind,
    name: s.name,
    registrar: 'registrar' in s ? s.registrar : null,
    issuedTo: 'issuedTo' in s ? s.issuedTo : null,
    expiresOn: s.expiresOn,
    note: s.note,
    createdAt: now,
  });
  inserted++;
}

console.log(`样例数据完成：新增 ${inserted} 条，跳过 ${samples.length - inserted} 条（已存在）`);
db.close();
