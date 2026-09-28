#!/usr/bin/env node
/*
 * 透析患者 社会資源活用支援ツール — リリース前回帰テスト
 *
 * 使い方:
 *   npm test                                   # index.html を対象に全テスト
 *   node tests/regression.test.js path/to/index.html --random 600 --seed 20260928
 *
 * 目的:
 *   構文チェック（node --check）では検出できない「特定の分岐でだけ起きる実行時例外」と、
 *   読者／0-B／R-7／R-9〜R-12／自己監査⑦などの分岐異常、安全ルール文の脱落を、実際にHTMLを動かして検出する。
 *
 * 期待値（SPEC）は実装から読み取らず、このファイルに仕様として固定している。
 * プロンプト文言を「意図的に」変更したときは、SPEC の該当文字列も同時に更新すること。
 * SPEC を更新せずにテストが落ちた場合は、意図しない文言変更・脱落の可能性がある。
 */
'use strict';
const fs = require('fs');
const path = require('path');
const { JSDOM, VirtualConsole } = require('jsdom');

// ───────────────────────── 引数 ─────────────────────────
const args = process.argv.slice(2);
const opt = (name, def) => { const i = args.indexOf(name); return i >= 0 ? args[i + 1] : def; };
const HTML_PATH = path.resolve(args.find(a => !a.startsWith('--') && !/^\d+$/.test(a)) || 'index.html');
const RANDOM_N = Number(opt('--random', 600));
const SEED = Number(opt('--seed', 20260928));
const VERBOSE = args.includes('--verbose');

// ───────────────────────── 仕様（期待値） ─────────────────────────
const V = {
  staffUser: 'クリニック職員',
  selfUser: '患者本人',
  staffRoute: 'クリニック職員がAIチャットで候補を調べたい',
  unknown: 'わからない・未入力',
};
const SPEC = {
  terminator: '以上で指示は終わりです。',
  reader: {
    staff: 'この回答の読者は、介護・福祉制度を専門としない透析クリニック職員です。',
    nonStaff: 'この回答の読者は、透析患者本人または家族・支援者等で、制度の専門家ではありません。',
  },
  zeroB: { staff: '0-B 医療機関側（最大5行', nonStaff: '0-B 医療機関に確認してもらうこと（最大5行' },
  audit7: { staff: '⑦主体の区別：', nonStaff: '⑦医療機関への確認：' },
  r7: {
    self: ['相談・申請を進めるかは本人が決める', '本人自身を読者としているため'],
    other: [
      '「情報だけ知りたい」「支援を希望していない」「本人の意向をまだ確認できていない」の場合も',
      'ただし同意済みとは扱わない。',
      '「本人の意向確認後」と条件を付けて書き',
      'Aの1点目を本人の意向確認とする。',
    ],
  },
  aAction: {
    self: 'R-7に該当する場合は1点目を「相談・申請を進めるかは本人が決める」とする。',
    other: 'R-7に該当する場合は1点目を本人の意向確認とする。',
  },
  // どの分岐でも必ず含まれるべき安全ルール・構造（脱落検出用）
  required: [
    '第1部は、第2部以降のすべての指示（出力形式、字数、候補数、網羅性）より優先します。',
    'R-1【根拠】', 'R-2【入力にない事実を作らない】', 'R-3【欠測の扱い】', 'R-4【AIが判定しないこと】',
    'R-5【金額】', 'R-6【本人の状況の表現】', 'R-7【本人の意向】', 'R-8【検索できない場合】',
    'R-9【候補化前の適用条件確認】', 'R-10【強い行動断定】', 'R-11【推定禁止と探索継続の両立】', 'R-12【費用感】',
    '対象外・制限条件の記載を公式本文で確認できない場合は、「制限なし」と扱わず',
    '見立てを「情報不足」とし',
    '公式本文そのものを確認できない候補はS6に従う。',
    '全国一律の法定要件は、第2部「全国共通制度と地域運用」の区分に従い、国の公式本文で確認できればよい。',
    'それを理由に関連制度の探索自体を止めない。',
    '情報不足（判断に必要な入力が欠測、または候補性を左右する条件を公式本文で確認できない）',
    '候補ごとに対象外・除外・期限・継続利用制限まで照合し、確認できない条件を「制限なし」としていないか（R-9）',
    '「必須」「期限」「失権」等の断定は、適用される実施主体の公式本文（全国一律の法定要件は国の公式本文）で確認済みか（R-10）',
    '推定禁止を理由に関連制度の探索を止めていないか（R-11）',
    'S5.5【候補決定後の費用調査】',
    'B-費用. 候補となった制度・サービスの費用感',
    '費用調査は候補決定後に行い、費用で候補を削除・並べ替えしていないか。',
    '年金額、年齢、手帳等から所得区分・負担割合・上限区分を推定しない。',
    '別途費用の記載を公式本文で確認できないことを「別途費用なし」と扱わない。',
    '1単位＝10円と仮定しない。',
    '同じチャット内で「週2回ならいくら」等の追加質問を受けた場合にも継続して適用する。',
    'その証の対象疾病名・対象障害・認定理由・所得区分は、入力に書かれていない限り「入力なし」として扱う。',
    '透析の方法だけから施設への通院回数を推定しない。',
    '(c) 入力された「在宅継続の緊急度」を、別の区分へ上書き・再判定しない。',
    '住民税の「課税／非課税」の入力だけでは所得区分が確定しない制度では、区分未確定として扱う。',
    '- 特定疾病の区別：',
    'それをAI独自の「緊急度」「緊急性」として表現しない。',
    '▼症例データ開始', '【ツールが入力時に表示した整合性の指摘】', '【元の質問アンケート結果】', '▲症例データ終了',
    'S1【検索軸の抽出】', 'S6【確認できない場合】',
    '特に次は、該当し得る入力がある限り、H0を「？」とする前に国・都道府県・市区町村等の公式本文を検索する',
    '透析実施、診断名、証の有無等だけから対象疾病、障害等級、受給資格を推定してはならず',
    '取得可能性を断定せずに公式要件を確認する。',
    'S3の中核確認項目が「？」のまま回答を終える場合は、未確認の制度名を明示し',
    '末尾に「続けて○○を公式情報で調べる」ための具体的な依頼例を1行示す。',
    '入力で申請中と確認できる制度は「情報不足（申請中）」と表記し、「未取得・未申請」とは表現しない。',
    '申請中を含む複合選択肢は入力表現のまま示す',
    'ツール指摘には誤りとは限らない確認事項が含まれるため、誤入力と断定せず、確認したい組み合わせとして示す。',
    '0-0. 入力の要点', 'H. 参照URL一覧と人による確認欄', 'AI自己監査記録（AIの自己申告）',
    '「検証済み」とは書かない。',
  ],
  // v4.31 R-12：意味を持つ条項（見出しだけでなく中身を固定）
  costClauses: [
    '候補の採否・順位付け・探索範囲、およびA・C・Eで示す相談・行動の順序や時期を変える材料にしない。',
    '候補を先に全て決め、費用調査後に候補を削除・並べ替え・追加しない。',
    '負担割合が未確定なら1割だけを例示しない。',
    '桁感を示す場合は、その桁感が成立する負担割合等の前提を必ず明示する。',
    '負担割合、生活保護・公費等の適用状況が欠測して本人負担の前提を確定できない場合は、一般的な桁感を本人負担として示さず「要確認」とする。',
    '費用構造：要確認',
    '月額総額構造として扱い',
    '「最終的な自己負担」と「一時的な立替額」を区別する。',
    '「無料」「0円」「負担なし」「上限で済む」「全額自己負担」もR-10の強い断定として扱う。',
    '一般的な自己負担の桁感をそのまま当てはめず',
    '「週○回なら月○円」等の月額を創作しない。',
    '照会時点で施行中の内容か',
    '適用を確認できない軽減額を費用感へ織り込まない。',
    '数字を安全に示せない候補も削除せず「要確認」とする。',
    '⑪費用感：',
    '利用者が示した仮定',
    '費用が生じないことを公式本文で確認できた候補を除き、Bに挙げた全候補について',
  ],
  // 順序：前の文字列が後の文字列より先に現れること
  order: [
    ['R-11【', 'R-12【費用感】', '第2部　用語の定義'],
    ['S5【照合と候補化】', 'S5.5【候補決定後の費用調査】', 'S6【確認できない場合】'],
    ['\nB. 検討する制度・サービス候補', '\nB-費用. ', '\nC. 短期・中期'],
  ],
  // 費用の危険なアンカー（プロンプト中に現れてはいけない）
  costForbidden: [
    /1割(負担)?(を|で)(前提|仮定|概算|計算|例示して(よい|よ))/,
    /1単位＝10円(で|として|を目安)/,
    /[0-9０-９]+\s*[～~〜\-]\s*[0-9０-９]+\s*[%％]/,
    /順位付けに費用|費用(も|を)考慮して(順位|並べ|絞)/,
    /候補は省略/,
  ],
  forbidden: [/undefined/, /\$\{/, /\[object /, /NaN/, /透析(実施|中)?(から|なら|のため).{0,12}(対象|該当)として扱/],
  // 誤検出してはいけない一般的な補足文
  piiShouldPass: [
    '週3回透析。第2号被保険者か確認したい。', '透析クリニックと総合病院の連携で順番待ち。週3-4回の送迎が必要。',
    '受給者番号は分からない。', '家族送迎が来月頃に終了予定。', '階段は3段ある', '１日2回の服薬確認',
    '朝9時30分に送迎', 'バス停まで300m', '年金は月8万円程度',
  ],
  // 必ず停止すべき補足文
  piiShouldBlock: [
    '連絡先は090-1234-5678', 'メール test@example.com', '住所は王子1丁目2番3号', '氏名：テスト',
    '患者ID: A12345', '昭和20年3月4日生まれ',
  ],
  municipalityShouldPass: ['東京都北区', '北海道札幌市中央区', '京都府京都市上京区', '大阪府堺市北区', '長野県下伊那郡阿智村'],
};

// ───────────────────────── 基盤 ─────────────────────────
const HTML = fs.readFileSync(HTML_PATH, 'utf8');
function mulberry32(a) { return function () { a |= 0; a = a + 0x6D2B79F5 | 0; let t = Math.imul(a ^ a >>> 15, 1 | a); t = t + Math.imul(t ^ t >>> 7, 61 | t) ^ t; return ((t ^ t >>> 14) >>> 0) / 4294967296; }; }

function openPage(seed = SEED) {
  const errors = [];
  const vc = new VirtualConsole();
  vc.on('jsdomError', e => { const m = String(e && e.message || e); if (!/Not implemented: (window\.scrollTo|window\.print)/.test(m)) errors.push(m); });
  vc.on('error', e => errors.push('console.error: ' + e));
  const dom = new JSDOM(HTML, {
    runScripts: 'dangerously', pretendToBeVisual: true, virtualConsole: vc, url: 'https://example.test/',
    beforeParse(w) {
      w.Math.random = mulberry32(seed);
      w.HTMLElement.prototype.scrollIntoView = function () {};
      w.scrollTo = () => {}; w.print = () => { w.__printed = true; };
      w.confirm = () => true; w.alert = () => {};
      w.__clip = null; w.__clipboardReadFails = false; w.navigator.clipboard = { writeText: async t => { w.__clip = t; }, readText: async () => { if (w.__clipboardReadFails) throw new Error('permission denied'); return w.__clip || ''; } };
      w.document.execCommand = () => true;
      w.__downloads = []; w.__downloadNames = []; w.URL.createObjectURL = b => { w.__downloads.push(b); return 'blob:test'; }; w.URL.revokeObjectURL = () => {};
      w.HTMLAnchorElement.prototype.click = function () { w.__downloadNames.push(this.download); };
      if (!w.Blob.prototype.text) w.Blob.prototype.text = function () { return new Promise((res, rej) => { const r = new w.FileReader(); r.onload = () => res(r.result); r.onerror = rej; r.readAsText(this); }); };
      w.addEventListener('error', e => errors.push('window.error: ' + e.message));
      w.addEventListener('unhandledrejection', e => errors.push('unhandledrejection: ' + (e.reason && e.reason.message || e.reason)));
    },
  });
  const w = dom.window, d = w.document, $ = id => d.getElementById(id);
  const fire = (el, type) => el.dispatchEvent(new w.Event(type, { bubbles: true }));
  const page = {
    w, d, $, errors,
    options: id => [...$(id).options].map(o => o.value),
    set(id, v) { const el = $(id); el.value = v; if (el.value !== v) throw new Error(`選択肢がありません: ${id}=${v}`); fire(el, 'change'); },
    text(id, v) { $(id).value = v; fire($(id), 'input'); },
    consent() { $('useRulesConfirm').checked = true; fire($('useRulesConfirm'), 'change'); },
    confirmAll({ consistency = false } = {}) {
      $('privacyConfirm').checked = true; fire($('privacyConfirm'), 'change');
      if (consistency) { $('consistencyConfirm').checked = true; fire($('consistencyConfirm'), 'change'); }
    },
    submit() { const f = $('caseForm'); if (f.requestSubmit) f.requestSubmit(); else f.dispatchEvent(new w.Event('submit', { cancelable: true })); },
    prompt: () => $('researchPrompt').value,
    memo: () => $('clinicMemo').value,
    status: () => $('piiStatus').textContent,
    close: () => w.close(),
  };
  return page;
}

// ───────────────────────── 結果集計 ─────────────────────────
const results = [];
function record(suite, name, failures) {
  results.push({ suite, name, failures });
  if (VERBOSE || failures.length) console.log(`${failures.length ? '  ✗' : '  ✓'} [${suite}] ${name}${failures.length ? '\n      - ' + failures.join('\n      - ') : ''}`);
}
function expectedBranch(userType, route) {
  const staff = userType === V.staffUser || route === V.staffRoute;
  const self = !staff && userType === V.selfUser;
  return { staff, self };
}

// 生成された相談文を仕様に照らして検査する。失敗理由の配列を返す。
function checkPrompt(p, { staff, self }, page) {
  const f = [];
  if (!p) return ['相談文が生成されていない'];
  if (!p.trimEnd().endsWith(SPEC.terminator)) f.push('末尾が終端文で終わっていない（途中切断の可能性）');
  for (const re of SPEC.forbidden) if (re.test(p)) f.push(`禁止パターン混入: ${re}`);
  for (const s of SPEC.required) if (!p.includes(s)) f.push(`必須文の欠落: ${s}`);
  for (const c of SPEC.costClauses) if (!p.includes(c)) f.push(`R-12条項の欠落: ${c}`);
  for (const seq of SPEC.order) { const idx = seq.map(x => p.indexOf(x)); if (idx.some(i => i < 0) || !idx.every((v, i) => i === 0 || idx[i - 1] < v)) f.push(`順序の異常: ${seq.join(' → ')}`); }
  for (const re of SPEC.costForbidden) if (re.test(p)) f.push(`費用の危険なアンカー: ${re}`);
  if ((p.match(/R-7【本人の意向】/g) || []).length !== 1) f.push('R-7 が1回ではない');

  const has = s => p.includes(s);
  if (has(SPEC.reader.staff) !== staff || has(SPEC.reader.nonStaff) !== !staff) f.push(`読者分岐の異常（期待: ${staff ? '職員' : '本人・家族'}）`);
  if (has(SPEC.zeroB.staff) !== staff || has(SPEC.zeroB.nonStaff) !== !staff) f.push(`0-B分岐の異常（期待: ${staff ? '職員版' : '簡略版'}）`);
  if (has(SPEC.audit7.staff) !== staff || has(SPEC.audit7.nonStaff) !== !staff) f.push(`自己監査⑦分岐の異常（期待: ${staff ? '主体の区別' : '医療機関への確認'}）`);
  const selfR7 = SPEC.r7.self.every(has), anySelfR7 = SPEC.r7.self.some(has);
  const otherR7 = SPEC.r7.other.every(has), anyOtherR7 = SPEC.r7.other.some(has);
  if (self && (!selfR7 || anyOtherR7)) f.push('R-7分岐の異常（期待: 本人向け）');
  if (!self && (!otherR7 || anySelfR7)) f.push('R-7分岐の異常（期待: 家族・支援者・職員向け。意向未確認・意向確認後の条件を含むこと）');
  if (has(SPEC.aAction.self) !== self || has(SPEC.aAction.other) !== !self) f.push('A節の1点目指示の分岐異常');

  // 元の症例条件が区切りの内側に丸ごと入っているか（J節の材料）
  if (page) {
    if (p.includes('\nJ. 元の質問アンケート結果\n')!==page.$('includeOriginalInAnswer').checked) f.push('Jの表示選択が相談文へ反映されていない');
    if (p.includes('\nI. 略称対応表\n')!==page.$('includeAbbreviationsInAnswer').checked) f.push('Iの表示選択が相談文へ反映されていない');
    const original = page.w.eval('conditionLines()');
    const start = p.indexOf('\n▼症例データ開始\n'), end = p.indexOf('\n▲症例データ終了'), at = p.indexOf(original);
    if (start < 0 || end < 0) f.push('症例データの区切り行が見つからない');
    if (at < 0) f.push('元の質問アンケート結果が相談文に完全な形で含まれていない');
    else if (!(start < at && at + original.length <= end)) f.push('元の質問アンケート結果が症例データ区切りの外にある');
  }
  return f;
}

// ───────────────────────── テスト群 ─────────────────────────
function testLoad() {
  const pg = openPage();
  const f = [...pg.errors];
  if (!pg.$('markdownPanel').classList.contains('hidden')) f.push('同意前からMarkdown保存区画が表示されている');
  pg.consent();
  if (pg.$('inputGate').disabled) f.push('同意後も入力欄が無効のまま');
  if (pg.$('markdownPanel').classList.contains('hidden')) f.push('同意後もMarkdown保存区画が非表示のまま');
  pg.$('useRulesConfirm').checked = false; pg.$('useRulesConfirm').dispatchEvent(new pg.w.Event('change', { bubbles: true }));
  if (!pg.$('markdownPanel').classList.contains('hidden')) f.push('同意解除後もMarkdown保存区画が表示されている');
  record('起動', '読み込み・利用条件への同意・Markdown表示ゲート', f);
  pg.close();
}

function testCombinations() {
  const probe = openPage();
  const UT = probe.options('userType'), DR = probe.options('desiredRoute'), PW = probe.options('personWish');
  probe.close();
  let n = 0, ai = 0;
  for (const ut of UT) for (const dr of DR) for (const pw of PW) {
    n++;
    const pg = openPage(SEED + n);
    const f = [];
    try {
      pg.consent();
      pg.set('userType', ut); pg.set('desiredRoute', dr); pg.set('personWish', pw);
      pg.set('age', '70～74歳'); pg.text('municipality', '東京都北区'); pg.set('dialysisType', '施設血液透析');
      pg.set('transport', '家族・知人の送迎'); pg.set('urgency', '数か月以内に悪化懸念');
      pg.confirmAll();
      pg.submit();
      const wantsAI = dr.includes('AIチャット');
      if (!pg.memo()) f.push(`相談メモが生成されない（status: ${pg.status()}）`);
      if (wantsAI) { ai++; f.push(...checkPrompt(pg.prompt(), expectedBranch(ut, dr), pg)); }
      else if (pg.prompt()) f.push('AIを使わない経路で相談文が生成された');
    } catch (e) { f.push('テスト実行中の例外: ' + e.message); }
    f.unshift(...pg.errors.map(e => 'JS例外: ' + e));
    record('全組み合わせ', `入力担当者=${ut} / 使い方=${dr} / 本人の希望=${pw}`, f);
    pg.close();
  }
  return { n, ai };
}

function testTargetedIntent() {
  const cases = [
    ['家族・支援者', 'AIチャットで調べてからクリニックへ相談したい', '本人の意向をまだ確認できていない'],
    ['クリニック職員', V.staffRoute, '本人の意向をまだ確認できていない'],
    ['患者本人', 'AIチャットで調べてからクリニックへ相談したい', '情報だけ知りたい'],
    ['患者本人', 'AIチャットで調べてからクリニックへ相談したい', '支援を希望していない'],
    ['患者本人', V.staffRoute, '情報だけ知りたい'], // 旧M2
  ];
  for (const [ut, dr, pw] of cases) {
    const pg = openPage();
    pg.consent(); pg.set('userType', ut); pg.set('desiredRoute', dr); pg.set('personWish', pw);
    pg.set('age', '40～64歳'); pg.text('municipality', '東京都北区'); pg.set('dialysisType', '施設血液透析'); pg.text('notes', '通院が大変');
    pg.confirmAll(); pg.submit();
    const p = pg.prompt();
    const f = [...pg.errors.map(e => 'JS例外: ' + e), ...checkPrompt(p, expectedBranch(ut, dr), pg)];
    if (!p.includes(`- 本人の希望：${pw}`)) f.push('本人の希望が入力表現のまま症例データに入っていない');
    record('本人意向', `${ut} / ${dr} / ${pw}`, f);
    pg.close();
  }
}

function testConsistency() {
  const pg = openPage();
  const f = [];
  pg.consent(); pg.set('userType', V.staffUser); pg.set('desiredRoute', V.staffRoute);
  pg.set('age', '75～84歳'); pg.text('municipality', '東京都北区'); pg.set('dialysisType', '施設血液透析'); pg.set('urgency', '安定'); pg.set('healthInsurance', '国民健康保険');
  pg.confirmAll(); pg.submit();
  if (pg.prompt()) f.push('整合性確認なしで生成された');
  if (!/組み合わせ/.test(pg.status())) f.push('整合性による停止メッセージが出ない: ' + pg.status());
  if (pg.$('consistencyBox').classList.contains('hidden')) f.push('整合性の確認欄が表示されない');
  pg.confirmAll({ consistency: true }); pg.submit();
  const p = pg.prompt();
  const issues = pg.w.eval('consistencyIssues()');
  if (!issues.length) f.push('テスト前提: 整合性の指摘が0件');
  for (const i of issues) if (!p.includes(`- ${i}`)) f.push('整合性の指摘が相談文に渡っていない: ' + i.slice(0, 30));
  f.push(...checkPrompt(p, expectedBranch(V.staffUser, V.staffRoute), pg));
  record('整合性', '75歳以上＋国民健康保険', [...pg.errors, ...f]);
  pg.close();

  const pg2 = openPage();
  pg2.consent(); pg2.set('age', '70～74歳'); pg2.text('municipality', '東京都北区'); pg2.set('dialysisType', '施設血液透析'); pg2.set('urgency', '安定');
  pg2.set('desiredRoute', 'AIチャットで調べてからクリニックへ相談したい'); pg2.confirmAll(); pg2.submit();
  const block = pg2.prompt().split('【ツールが入力時に表示した整合性の指摘】')[1] || '';
  record('整合性', '指摘なしの場合は「なし」', /\n\s*なし\s*\n/.test(block.split('【元の質問アンケート結果】')[0]) ? [] : ['「なし」が入っていない']);
  pg2.close();

  const consistencyCases = [
    ['高齢受給者証＋65～69歳', pg => { pg.set('age','65～69歳'); [...pg.$('heldCerts').querySelectorAll('input')].find(x=>x.value==='高齢受給者証等').checked=true; }, '高齢受給者証等'],
    ['生活保護申請中＋医療券', pg => { pg.set('publicAssistance','生活保護を申請中・相談中'); [...pg.$('heldCerts').querySelectorAll('input')].find(x=>x.value==='生活保護の医療券等').checked=true; }, '申請・決定の現在地'],
    ['生活保護申請中＋障害者医療費助成証', pg => { pg.set('publicAssistance','生活保護を申請中・相談中'); [...pg.$('heldCerts').querySelectorAll('input')].find(x=>x.value==='障害者医療費助成の受給者証').checked=true; }, '現在の適用状況'],
    ['車椅子乗車必要＋歩行器', pg => { pg.set('boarding','車椅子のまま乗車が必要'); pg.set('wheelchair','歩行器'); }, '場面による使い分け'],
    ['施設住まい＋支援者同居', pg => { pg.set('living','施設・住まい系サービス'); pg.set('distance','同居'); }, '入力の意味を確認'],
  ];
  for (const [name, prep, expected] of consistencyCases) {
    const pc = openPage();
    pc.consent(); pc.set('userType', V.staffUser); pc.set('desiredRoute', V.staffRoute); pc.set('age','70～74歳'); pc.text('municipality','東京都北区'); pc.set('dialysisType','施設血液透析'); pc.set('urgency','安定'); prep(pc);
    const issues = pc.w.eval('consistencyIssues()');
    const ff = [];
    if (!issues.some(x => x.includes(expected))) ff.push(`確認指摘が出ない: ${expected}`);
    pc.confirmAll({ consistency: true }); pc.submit();
    const pp = pc.prompt();
    for (const i of issues) if (!pp.includes(`- ${i}`)) ff.push('確認指摘が相談文に渡っていない: ' + i.slice(0,30));
    record('整合性', name, [...pc.errors, ...ff]);
    pc.close();
  }

  const noWarnCases = [
    ['高齢受給者証＋70～74歳＋国民健康保険', pg => { pg.set('age','70～74歳'); pg.set('healthInsurance','国民健康保険'); [...pg.$('heldCerts').querySelectorAll('input')].find(x=>x.value==='高齢受給者証等').checked=true; }],
    ['年齢未入力＋高齢受給者証', pg => { pg.set('age','わからない・未入力'); [...pg.$('heldCerts').querySelectorAll('input')].find(x=>x.value==='高齢受給者証等').checked=true; }],
  ];
  for (const [name, prep] of noWarnCases) {
    const pc = openPage(); pc.consent(); pc.set('userType', V.staffUser); pc.set('desiredRoute', V.staffRoute); pc.text('municipality','東京都北区'); pc.set('dialysisType','施設血液透析'); pc.set('urgency','安定'); prep(pc);
    const issues=pc.w.eval('consistencyIssues()');
    record('整合性', name, issues.length ? ['誤警告: '+issues.join(' / ')] : []); pc.close();
  }
  const late = openPage(); late.consent(); late.set('age','70～74歳'); late.set('healthInsurance','後期高齢者医療'); [...late.$('heldCerts').querySelectorAll('input')].find(x=>x.value==='高齢受給者証等').checked=true;
  const lateIssues=late.w.eval('consistencyIssues()'); record('整合性','高齢受給者証＋70～74歳＋後期高齢者医療', lateIssues.some(x=>x.includes('高齢受給者証等'))?[]:['確認指摘が出ない']); late.close();

  for (const [name, prep] of [
    ['生活保護申請中＋医療券', pg=>{pg.set('publicAssistance','生活保護を申請中・相談中'); [...pg.$('heldCerts').querySelectorAll('input')].find(x=>x.value==='生活保護の医療券等').checked=true;}],
    ['生活保護申請中＋障害者医療費助成証', pg=>{pg.set('publicAssistance','生活保護を申請中・相談中'); [...pg.$('heldCerts').querySelectorAll('input')].find(x=>x.value==='障害者医療費助成の受給者証').checked=true;}],
    ['施設住まい＋支援者同居', pg=>{pg.set('living','施設・住まい系サービス'); pg.set('distance','同居');}],
  ]) {
    const pc=openPage(); prep(pc); const issues=pc.w.eval('consistencyIssues()');
    const bad=issues.filter(x=>/矛盾|誤り|誤入力/.test(x)); record('整合性', name+'を矛盾断定しない', bad.length?['過剰断定: '+bad.join(' / ')]:[]); pc.close();
  }
}

function testGates() {
  const base = pg => { pg.consent(); pg.set('desiredRoute', 'AIチャットで調べてからクリニックへ相談したい'); pg.set('age', '70～74歳'); pg.text('municipality', '東京都北区'); pg.set('dialysisType', '施設血液透析'); pg.set('urgency', '安定'); };
  const run = (name, prep, shouldGenerate) => {
    const pg = openPage(); base(pg); prep(pg); pg.submit();
    const got = !!pg.prompt();
    record('ゲート', name, [...pg.errors, ...(got === shouldGenerate ? [] : [`${shouldGenerate ? '生成されるべきが停止' : '停止すべきが生成'}（status: ${pg.status()}）`])]);
    pg.close();
  };
  run('目視確認なしでは停止', () => {}, false);
  run('市区町村なしでは停止（AI経路）', pg => { pg.text('municipality', ''); pg.confirmAll(); }, false);
  run('最低限の入力で生成', pg => pg.confirmAll(), true);
  for (const n of SPEC.piiShouldPass) run(`PII誤検出なし: ${n}`, pg => { pg.text('notes', n); pg.confirmAll(); }, true);
  for (const n of SPEC.piiShouldBlock) run(`PII停止: ${n}`, pg => { pg.text('notes', n); pg.confirmAll(); }, false);
  for (const m of SPEC.municipalityShouldPass) run(`市区町村: ${m}`, pg => { pg.text('municipality', m); pg.confirmAll(); }, true);
}

function testRevisedQuestionsAndOutputOptions() {
  const pg = openPage(); pg.consent();
  const f = [];
  if (pg.$('frequency')) f.push('削除した通院頻度の入力欄が残っている');
  if (pg.options('transport').includes('救急搬送に依存') || !pg.options('transport').includes('その他')) f.push('送迎の旧選択肢が残るか「その他」がない');
  pg.set('dialysisType','腹膜透析＋施設血液透析'); pg.set('disability','手帳なし');
  if (!pg.$('disabilityStatus').textContent.includes('身体障害者手帳')) f.push('併用療法で手帳の確認案内が出ない');
  if (pg.w.eval('consistencyIssues()').some(x => /通院頻度/.test(x))) f.push('削除した通院頻度の整合性指摘が残っている');
  record('項目変更','併用療法・送迎・頻度削除', [...pg.errors,...f]); pg.close();
  for (const original of [true,false]) for (const abbreviations of [true,false]) {
    const p=openPage(); p.consent();p.set('desiredRoute','AIチャットで調べてからクリニックへ相談したい');p.set('age','70～74歳');p.text('municipality','東京都北区');p.set('dialysisType','腹膜透析＋施設血液透析');p.set('urgency','安定');
    p.$('includeOriginalInAnswer').checked=original;p.$('includeAbbreviationsInAnswer').checked=abbreviations;p.confirmAll();p.submit();
    const t=p.prompt(),fail=[...p.errors];
    if (t.includes('\nJ. 元の質問アンケート結果\n')!==original) fail.push('Jの出力指定がチェックと一致しない');
    if (t.includes('\nI. 略称対応表\n')!==abbreviations) fail.push('Iの出力指定がチェックと一致しない');
    if (!t.includes('【元の質問アンケート結果】\n'+p.w.eval('conditionLines()'))) fail.push('Jを非表示にするとAIへの症例条件まで消える');
    if (original && !t.includes('Jが元条件を含むため再入力は不要')) fail.push('Jありの別AIレビュー案内がない');
    if (!original && (!t.includes('第3部の症例条件も別途渡す必要') || !t.includes('Jを再掲していないか'))) fail.push('Jなしのレビュー案内または自己監査が不整合');
    fail.push(...checkPrompt(t,expectedBranch(p.$('userType').value,p.$('desiredRoute').value),p));
    record('回答オプション',`元アンケート=${original} / 略称=${abbreviations}`,fail);p.close();
  }
}

async function testMarkdownFlow() {
  const p=openPage();p.consent();const f=[];
  p.text('caseId','A001');p.set('desiredRoute','AIチャットで調べてからクリニックへ相談したい');p.set('age','70～74歳');p.text('municipality','東京都北区');p.set('dialysisType','施設血液透析');p.set('urgency','安定');p.confirmAll();p.submit();
  p.$('copyResearchBtn').click();await new Promise(r=>setTimeout(r,0));
  if (!p.$('markdownFilename').value.match(/^A001_\d{8}-\d{6}\.md$/)) f.push('識別コード＋日時のファイル名にならない');
  p.w.__clipboardReadFails=true;p.$('importClipboardBtn').click();await new Promise(r=>setTimeout(r,0));
  p.text('markdownContent','# 手動で貼り付けたAI回答');p.set('age','65～69歳');
  if (p.$('markdownContent').value!=='# 手動で貼り付けたAI回答') f.push('手動貼り付けしたAI回答が入力変更で消える');
  p.confirmAll();p.submit();
  p.w.__clip='以前の文章';p.w.confirm=()=>false;p.$('copyResearchBtn').click();await new Promise(r=>setTimeout(r,0));
  if (p.w.__clip!==p.prompt() || !p.$('copyStatus').textContent.includes('コピーしました')) f.push('確認欄の置き換えをキャンセルすると相談文のコピーも止まる');
  if (p.$('markdownContent').value!=='# 手動で貼り付けたAI回答') f.push('置き換えキャンセル時に確認欄の内容が変わる');
  p.w.confirm=()=>true;p.w.__clipboardReadFails=false;
  p.w.__clip='# AIの回答\n本文';p.$('importClipboardBtn').click();await new Promise(r=>setTimeout(r,0));
  if (p.$('markdownContent').value!==p.w.__clip) f.push('AI回答の取り込みに失敗');
  p.text('markdownFilename','A001_相談結果.md');const n=p.w.__downloads.length;p.$('saveMarkdownBtn').click();
  if (p.w.__downloadNames[n]!=='A001_相談結果.md' || await p.w.__downloads[n].text()!=='# AIの回答\n本文') f.push('編集したファイル名・内容でMarkdown保存されない');
  p.w.__clipboardReadFails=true;p.$('importClipboardBtn').click();await new Promise(r=>setTimeout(r,0));
  if (!p.$('markdownStatus').textContent.includes('手動で貼り付け')) f.push('クリップボード権限拒否時の手動貼付案内がない');
  p.text('markdownContent','手動で貼り付けた内容');p.text('markdownFilename','回答');const n2=p.w.__downloads.length;p.$('saveMarkdownBtn').click();
  if (p.w.__downloadNames[n2]!=='回答.md') f.push('拡張子なしのファイル名へ .md が付かない');
  p.$('resetBtn').click();if (!p.$('includeOriginalInAnswer').checked||!p.$('includeAbbreviationsInAnswer').checked||p.$('markdownContent').value) f.push('リセットで既定のチェックと保存欄が戻らない');
  record('Markdown','コピー・回答取込・保存・権限拒否・リセット',[...p.errors,...f]);p.close();
}

function testRandom() {
  const pg = openPage(SEED);
  pg.consent();
  let bad = 0;
  for (let i = 1; i <= RANDOM_N; i++) {
    const before = pg.errors.length;
    pg.$('randomCaseBtn').click();
    const ut = pg.$('userType').value, dr = pg.$('desiredRoute').value;
    const f = [...pg.errors.slice(before).map(e => 'JS例外: ' + e), ...checkPrompt(pg.prompt(), expectedBranch(ut, dr), pg)];
    if (pg.w.eval('consistencyIssues().length')) f.push('ランダム症例に整合性の指摘が残った');
    if (f.length) { bad++; record('ランダム', `#${i}（seed=${SEED}） 入力担当者=${ut} / 使い方=${dr} / 本人の希望=${pg.$('personWish').value}`, f); }
  }
  record('ランダム', `${RANDOM_N}回（seed=${SEED}）`, bad ? [`${bad}件で失敗（上記参照）`] : []);
  pg.close();
}

async function testCsvAndButtons() {
  const pg = openPage(SEED + 7);
  pg.consent();
  const snap = p => { const o = {}; p.d.querySelectorAll('#caseForm select, #caseForm input[type=text], #caseForm textarea').forEach(e => { o[e.id] = e.value; }); ['heldCerts', 'supportTasks', 'services'].forEach(g => { o[g] = [...p.$(g).querySelectorAll('input:checked')].map(x => x.value).join('|'); }); return o; };
  const saved = [];
  const extraNotes = ['', '=1+1 から始まる補足', '引用符"と、読点、改行\n二行目', '+先頭記号', ''];
  for (let i = 0; i < 5; i++) {
    pg.$('randomCaseBtn').click();
    pg.text('caseId', 'T' + i);
    if (extraNotes[i]) pg.text('notes', extraNotes[i]);
    pg.confirmAll({ consistency: true }); pg.submit();
    const prompt = pg.prompt();
    pg.confirmAll({ consistency: true });
    pg.$('saveCaseBtn').click();
    saved.push({ state: snap(pg), prompt });
  }
  const f = [...pg.errors];
  if (pg.w.__downloads.length < 5) f.push('CSVがダウンロードされない');
  const csv = await pg.w.__downloads[pg.w.__downloads.length - 1].text();
  if (!csv.includes("'=1+1")) f.push('数式インジェクション対策（先頭アポストロフィ）が効いていない');

  // 別ページで読込→呼び出し→再生成
  const pg2 = openPage(SEED + 8); pg2.consent();
  const file = new pg2.w.File([csv], 'cases.csv', { type: 'text/csv' });
  Object.defineProperty(pg2.$('caseFileInput'), 'files', { value: [file] });
  pg2.$('caseFileInput').dispatchEvent(new pg2.w.Event('change'));
  await new Promise(r => setTimeout(r, 300));
  if (!/5件/.test(pg2.$('caseLoadStatus').textContent)) f.push('CSV読込件数が5件にならない: ' + pg2.$('caseLoadStatus').textContent);
  for (const s of saved) {
    const grp = [...pg2.d.querySelectorAll('.case-group')].find(g => g.textContent.includes(`識別コード：${s.state.caseId}（`));
    if (!grp) { f.push('一覧に識別コードがない: ' + s.state.caseId); continue; }
    grp.querySelector('button').click();
    const after = snap(pg2);
    for (const k of Object.keys(s.state)) if (after[k] !== s.state[k]) f.push(`CSV往復で値が変わった: ${s.state.caseId}.${k}`);
    pg2.confirmAll({ consistency: true }); pg2.submit();
    if (pg2.prompt() !== s.prompt) f.push(`CSV往復後に相談文が変わった: ${s.state.caseId}`);
  }
  f.push(...pg2.errors);
  record('CSV', '保存→別ページで読込→呼び出し→再生成', f);
  pg2.close();

  // 旧版の送迎・頻度列を含むCSVは、送迎を見出しで引き継ぎ、頻度は無視する。
  const legacyRows=pg.w.eval('parseCSV')(csv);
  legacyRows[0][legacyRows[0].indexOf('透析のための通院の主な手段')]='現在の主な送迎';
  legacyRows[0].splice(2,0,'透析通院頻度');
  for(const row of legacyRows.slice(1))row.splice(2,0,'週3回');
  const legacyCsv='\uFEFF'+legacyRows.map(row=>pg.w.eval('toCsvRow')(row)).join('\r\n')+'\r\n';
  const pg4=openPage();pg4.consent();
  const oldFile=new pg4.w.File([legacyCsv],'old-cases.csv',{type:'text/csv'});
  Object.defineProperty(pg4.$('caseFileInput'),'files',{value:[oldFile]});
  pg4.$('caseFileInput').dispatchEvent(new pg4.w.Event('change'));
  await new Promise(r=>setTimeout(r,200));
  const legacyFailures=[...pg4.errors];
  const oldGroup=[...pg4.d.querySelectorAll('.case-group')].find(g=>g.textContent.includes('識別コード：T0（'));
  if(!oldGroup)legacyFailures.push('旧CSVの識別コードが読み込めない');
  else {oldGroup.querySelector('button').click();if(pg4.$('transport').value!==saved[0].state.transport)legacyFailures.push('旧CSVの送迎が失われた');if(pg4.$('frequency'))legacyFailures.push('旧CSVの頻度列がフォームに復活した');}
  record('CSV','旧見出し・頻度列の読み込み',legacyFailures);pg4.close();

  const rescuedRows=legacyRows.map(row=>[...row]);
  const oldTransportColumn=rescuedRows[0].indexOf('現在の主な送迎');
  rescuedRows[1][oldTransportColumn]='救急搬送に依存';
  const rescued=pg.w.eval('rowsToCases')(rescuedRows)[0];
  const pg5=openPage();pg5.consent();pg5.w.eval('applyCaseToForm')(rescued);
  record('CSV','旧版の救急搬送選択を推測で置換しない',[...pg5.errors,...(pg5.$('transport').value==='わからない・未入力'&&pg5.$('piiStatus').textContent.includes('旧版の「救急搬送に依存」')?[]:['旧選択肢が不明に戻らないか確認案内がない'])]);pg5.close();

  // 無関係なCSVは拒否
  const pg3 = openPage(); pg3.consent();
  const junk = new pg3.w.File(['品名,数量\nりんご,3\n'], 'junk.csv', { type: 'text/csv' });
  Object.defineProperty(pg3.$('caseFileInput'), 'files', { value: [junk] });
  pg3.$('caseFileInput').dispatchEvent(new pg3.w.Event('change'));
  await new Promise(r => setTimeout(r, 200));
  record('CSV', '無関係なCSVを拒否', /見つかりませんでした/.test(pg3.$('caseLoadStatus').textContent) ? [...pg3.errors] : ['無関係なCSVが読み込まれた']);
  pg3.close();

  // ボタン類
  const g = [];
  pg.text('caseId','');
  pg.$('randomCaseBtn').click();
  pg.$('copyResearchBtn').click(); await new Promise(r => setTimeout(r, 50));
  if (pg.w.__clip !== pg.prompt()) g.push('コピー内容が相談文と一致しない');
  if (pg.$('markdownContent').value !== pg.prompt() || !pg.$('markdownDetails').open) g.push('コピー後にMarkdown確認欄へ相談文が表示されない');
  const k = pg.w.__downloads.length; pg.$('saveMarkdownBtn').click();
  if (!pg.w.__downloads[k] || await pg.w.__downloads[k].text() !== pg.prompt()) g.push('Markdown保存内容が相談文と一致しない');
  if (!/^\d{8}-\d{6}\.md$/.test(pg.w.__downloadNames[k])) g.push('識別コードなしのファイル名が日時.mdにならない');
  pg.$('printBtn').click(); if (!pg.w.__printed) g.push('印刷が呼ばれない');
  pg.set('age', '40～64歳');
  if (!pg.$('resultPanel').classList.contains('hidden') || pg.prompt()) g.push('入力変更後に古い相談文が残っている');
  if (pg.$('markdownContent').value) g.push('入力変更後に保存前の古い相談文が残っている');
  record('ボタン', 'コピー／Markdown保存／印刷／入力変更時の破棄', [...pg.errors, ...g]);
  pg.close();
}

// ───────────────────────── 実行 ─────────────────────────
(async () => {
  const t0 = Date.now();
  console.log(`対象: ${HTML_PATH}`);
  console.log(`ランダム: ${RANDOM_N}回 / seed=${SEED}\n`);
  testLoad();
  const { n, ai } = testCombinations();
  testTargetedIntent();
  testConsistency();
  testGates();
  testRevisedQuestionsAndOutputOptions();
  testRandom();
  await testCsvAndButtons();
  await testMarkdownFlow();

  const failed = results.filter(r => r.failures.length);
  const bySuite = {};
  for (const r of results) { const s = bySuite[r.suite] || (bySuite[r.suite] = { pass: 0, fail: 0 }); r.failures.length ? s.fail++ : s.pass++; }
  console.log('\n──────── 集計 ────────');
  for (const [s, c] of Object.entries(bySuite)) console.log(`${c.fail ? '✗' : '✓'} ${s}: ${c.pass}件成功 / ${c.fail}件失敗`);
  console.log(`（全組み合わせ ${n}通り、うちAI経路 ${ai}通り）  ${((Date.now() - t0) / 1000).toFixed(1)}秒`);
  if (failed.length) {
    console.log(`\n結果: 失敗 ${failed.length}件 — リリースしないでください`);
    process.exit(1);
  }
  console.log('\n結果: すべて成功');
  process.exit(0);
})().catch(e => { console.error('テストハーネス自体のエラー:', e); process.exit(2); });
