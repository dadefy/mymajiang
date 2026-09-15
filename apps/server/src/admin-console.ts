export function adminConsoleHtml(): string {
  return `<!doctype html>
<html lang="zh-CN">
<head>
  <meta charset="utf-8">
  <meta name="viewport" content="width=device-width,initial-scale=1">
  <title>绵阳麻将管理后台</title>
  <style>
    :root { color-scheme: light; font-family: Inter, "Microsoft YaHei", sans-serif; background: #f4f6f8; color: #17212b; }
    * { box-sizing: border-box; }
    body { margin: 0; }
    header { background: #123d2c; color: white; padding: 18px 24px; display: flex; gap: 18px; align-items: center; justify-content: space-between; flex-wrap: wrap; }
    header h1 { margin: 0; font-size: 22px; }
    header p { margin: 4px 0 0; color: #b9d7ca; font-size: 13px; }
    .auth { display: flex; gap: 8px; min-width: min(100%, 520px); }
    .auth input { flex: 1; min-width: 180px; }
    main { max-width: 1440px; margin: 0 auto; padding: 20px; }
    .status { min-height: 40px; padding: 10px 14px; margin-bottom: 16px; border-radius: 8px; background: #e8eef2; }
    .status.ok { background: #dff3e8; color: #145b35; }
    .status.error { background: #ffe4e4; color: #8b1a1a; }
    .grid { display: grid; grid-template-columns: repeat(auto-fit, minmax(420px, 1fr)); gap: 18px; align-items: start; }
    section { background: white; border: 1px solid #dde3e7; border-radius: 12px; padding: 18px; box-shadow: 0 3px 14px rgba(18, 61, 44, .05); overflow: auto; }
    section.wide { grid-column: 1 / -1; }
    h2 { margin: 0 0 14px; font-size: 18px; }
    .toolbar { display: flex; gap: 8px; align-items: center; flex-wrap: wrap; margin-bottom: 12px; }
    input, select, button, textarea { border: 1px solid #bcc8ce; border-radius: 7px; padding: 8px 10px; font: inherit; background: white; }
    input:focus, select:focus, textarea:focus { outline: 2px solid #68aa8c; border-color: transparent; }
    button { cursor: pointer; background: #176b49; color: white; border-color: #176b49; }
    button.secondary { background: white; color: #176b49; }
    button.danger { background: #a83434; border-color: #a83434; }
    button:disabled { opacity: .55; cursor: wait; }
    table { width: 100%; border-collapse: collapse; font-size: 13px; }
    th, td { text-align: left; padding: 9px 8px; border-bottom: 1px solid #e7ecef; vertical-align: top; white-space: nowrap; }
    th { color: #53636c; background: #f8fafb; position: sticky; top: 0; }
    .muted { color: #70808a; }
    .badge { display: inline-block; padding: 2px 7px; border-radius: 999px; background: #e7efeb; }
    .row-actions { display: flex; gap: 6px; align-items: center; }
    .row-actions input { width: 90px; }
    .issued { white-space: pre-wrap; word-break: break-all; background: #11251c; color: #d7f7e7; padding: 12px; border-radius: 8px; max-height: 230px; overflow: auto; }
    dialog { border: 0; border-radius: 12px; width: min(900px, 92vw); max-height: 85vh; padding: 0; box-shadow: 0 18px 60px rgba(0,0,0,.28); }
    dialog::backdrop { background: rgba(8,20,14,.45); }
    .dialog-head { padding: 14px 18px; display: flex; justify-content: space-between; align-items: center; border-bottom: 1px solid #dde3e7; }
    .dialog-body { padding: 16px 18px; overflow: auto; max-height: 70vh; }
    @media (max-width: 600px) { main { padding: 10px; } .grid { grid-template-columns: 1fr; } section { padding: 12px; } header { padding: 14px; } }
  </style>
</head>
<body>
  <header>
    <div><h1>绵阳麻将管理后台</h1><p>邀请密钥、用户状态、积分与审计</p></div>
    <div class="auth"><input id="token" type="password" autocomplete="off" placeholder="粘贴超级管理员 JWT"><button id="connect">连接</button><button id="logout" class="secondary">清除</button></div>
  </header>
  <main>
    <div id="status" class="status">请输入开发环境启动时打印的管理员令牌。</div>
    <div class="grid">
      <section>
        <h2>邀请密钥</h2>
        <form id="issue-form" class="toolbar"><input id="key-count" type="number" min="1" max="100" value="1" aria-label="签发数量"><input id="key-note" maxlength="100" placeholder="备注"><button>签发</button><button id="refresh-keys" type="button" class="secondary">刷新</button></form>
        <div id="issued-wrap" hidden><p><strong>明文仅显示这一次，请立即保存。</strong></p><pre id="issued" class="issued"></pre><button id="copy-keys" class="secondary">复制全部</button></div>
        <table><thead><tr><th>提示位</th><th>备注</th><th>状态</th><th>创建时间</th><th>操作</th></tr></thead><tbody id="keys-body"></tbody></table>
      </section>
      <section>
        <h2>用户管理</h2>
        <form id="user-search" class="toolbar"><input id="user-query" maxlength="24" placeholder="用户 ID 或昵称"><select id="user-status"><option value="">全部状态</option><option value="active">正常</option><option value="temporarily_banned">临时封禁</option><option value="permanently_banned">永久封禁</option></select><button>搜索</button></form>
        <table><thead><tr><th>用户</th><th>积分</th><th>状态</th><th>操作</th></tr></thead><tbody id="users-body"></tbody></table>
      </section>
      <section class="wide">
        <h2>审计日志</h2>
        <div class="toolbar"><button id="refresh-audit" class="secondary">刷新</button></div>
        <table><thead><tr><th>时间</th><th>管理员</th><th>用户</th><th>动作</th><th>变更</th><th>原因</th></tr></thead><tbody id="audit-body"></tbody></table>
      </section>
    </div>
  </main>
  <dialog id="ledger-dialog"><div class="dialog-head"><strong id="ledger-title">积分流水</strong><button id="close-ledger" class="secondary">关闭</button></div><div class="dialog-body"><table><thead><tr><th>时间</th><th>类型</th><th>变化</th><th>余额</th><th>原因</th><th>操作</th></tr></thead><tbody id="ledger-body"></tbody></table></div></dialog>
  <script>
    const tokenInput = document.querySelector('#token');
    const statusBox = document.querySelector('#status');
    const ledgerDialog = document.querySelector('#ledger-dialog');
    let selectedUserId = '';

    tokenInput.value = sessionStorage.getItem('mymj-admin-token') || '';

    function showStatus(message, kind) {
      statusBox.textContent = message;
      statusBox.className = 'status' + (kind ? ' ' + kind : '');
    }

    function formatDate(value) {
      if (!value) return '-';
      return new Date(value).toLocaleString('zh-CN', { hour12: false });
    }

    function addCell(row, value, className) {
      const cell = document.createElement('td');
      cell.textContent = value == null ? '-' : String(value);
      if (className) cell.className = className;
      row.appendChild(cell);
      return cell;
    }

    function actionButton(label, handler, danger) {
      const button = document.createElement('button');
      button.type = 'button';
      button.textContent = label;
      if (danger) button.className = 'danger';
      button.addEventListener('click', async () => {
        button.disabled = true;
        try { await handler(); } catch (error) { showStatus(error.message, 'error'); } finally { button.disabled = false; }
      });
      return button;
    }

    async function api(path, options) {
      const token = tokenInput.value.trim();
      if (!token) throw new Error('请先输入管理员令牌');
      const init = Object.assign({}, options || {});
      init.headers = Object.assign({ Authorization: 'Bearer ' + token }, init.headers || {});
      if (init.body) init.headers['Content-Type'] = 'application/json';
      const response = await fetch(path, init);
      const text = await response.text();
      const body = text ? JSON.parse(text) : null;
      if (!response.ok) throw new Error((body && (body.message || body.code)) || ('HTTP ' + response.status));
      return body;
    }

    async function loadKeys() {
      const body = document.querySelector('#keys-body');
      body.replaceChildren();
      const result = await api('/v1/admin/invitation-keys');
      for (const key of result.keys) {
        const row = document.createElement('tr');
        addCell(row, key.keyHint);
        addCell(row, key.note || '-', 'muted');
        const state = key.revokedAt ? '已撤销' : (key.activated ? '已激活' : '未使用');
        addCell(row, state);
        addCell(row, formatDate(key.createdAt));
        const actions = addCell(row, '');
        if (!key.activated && !key.revokedAt) actions.appendChild(actionButton('撤销', async () => {
          if (!confirm('确定撤销这把尚未使用的密钥？')) return;
          await api('/v1/admin/invitation-keys/' + encodeURIComponent(key.keyId) + '/revoke', { method: 'POST' });
          showStatus('密钥已撤销', 'ok');
          await loadKeys();
        }, true));
        body.appendChild(row);
      }
    }

    async function issueKeys(event) {
      event.preventDefault();
      const count = Number(document.querySelector('#key-count').value);
      const note = document.querySelector('#key-note').value.trim();
      const result = await api('/v1/admin/invitation-keys', { method: 'POST', body: JSON.stringify({ count, note }) });
      const plaintext = result.keys.map((item) => item.key + (item.note ? '  ' + item.note : '')).join('\n');
      document.querySelector('#issued').textContent = plaintext;
      document.querySelector('#issued-wrap').hidden = false;
      showStatus('已签发 ' + result.keys.length + ' 把密钥，请立即保存明文。', 'ok');
      await loadKeys();
    }

    async function loadUsers(event) {
      if (event) event.preventDefault();
      const query = document.querySelector('#user-query').value.trim();
      const status = document.querySelector('#user-status').value;
      const parameters = new URLSearchParams();
      if (query) parameters.set('query', query);
      if (status) parameters.set('status', status);
      parameters.set('limit', '200');
      const result = await api('/v1/admin/users?' + parameters.toString());
      const body = document.querySelector('#users-body');
      body.replaceChildren();
      for (const user of result.users) {
        const row = document.createElement('tr');
        addCell(row, user.nickname + '\n' + user.userId).style.whiteSpace = 'pre-line';
        addCell(row, user.points);
        addCell(row, user.status);
        const actions = addCell(row, '');
        const wrap = document.createElement('div');
        wrap.className = 'row-actions';
        wrap.appendChild(actionButton('流水', () => loadLedger(user.userId)));
        wrap.appendChild(actionButton('积分', async () => {
          const deltaText = prompt('积分变化值（增加填正数，扣除填负数）');
          if (deltaText == null) return;
          const delta = Number(deltaText);
          const reason = prompt('调整原因');
          if (!Number.isSafeInteger(delta) || delta === 0 || !reason) throw new Error('请输入非零整数和调整原因');
          await api('/v1/admin/users/' + user.userId + '/points', { method: 'POST', body: JSON.stringify({ delta, reason }) });
          showStatus('积分调整成功', 'ok');
          await Promise.all([loadUsers(), loadAudit()]);
        }));
        const targetStatus = user.status === 'active' ? 'temporarily_banned' : 'active';
        const label = user.status === 'active' ? '封禁' : '解封';
        wrap.appendChild(actionButton(label, async () => {
          const reason = prompt(label + '原因');
          if (!reason) return;
          await api('/v1/admin/users/' + user.userId + '/status', { method: 'PATCH', body: JSON.stringify({ status: targetStatus, reason }) });
          showStatus(label + '成功', 'ok');
          await Promise.all([loadUsers(), loadAudit()]);
        }, user.status === 'active'));
        if (user.status !== 'permanently_banned') wrap.appendChild(actionButton('永久封禁', async () => {
          const reason = prompt('永久封禁原因');
          if (!reason) return;
          await api('/v1/admin/users/' + user.userId + '/status', { method: 'PATCH', body: JSON.stringify({ status: 'permanently_banned', reason }) });
          showStatus('永久封禁成功', 'ok');
          await Promise.all([loadUsers(), loadAudit()]);
        }, true));
        actions.replaceChildren(wrap);
        body.appendChild(row);
      }
    }

    async function loadLedger(userId) {
      selectedUserId = userId;
      const result = await api('/v1/admin/users/' + userId + '/points');
      document.querySelector('#ledger-title').textContent = '积分流水 · ' + userId + ' · 当前余额 ' + result.balance;
      const body = document.querySelector('#ledger-body');
      body.replaceChildren();
      const reversed = new Set(result.entries.filter((entry) => entry.reversalOf).map((entry) => entry.reversalOf));
      for (const entry of result.entries) {
        const row = document.createElement('tr');
        addCell(row, formatDate(entry.createdAt));
        addCell(row, entry.type);
        addCell(row, entry.delta > 0 ? '+' + entry.delta : entry.delta);
        addCell(row, entry.balanceBefore + ' → ' + entry.balanceAfter);
        addCell(row, entry.reason);
        const actions = addCell(row, '');
        if (entry.type === 'admin_adjustment' && !reversed.has(entry.ledgerId)) actions.appendChild(actionButton('撤销', async () => {
          const reason = prompt('撤销原因');
          if (!reason) return;
          await api('/v1/admin/users/' + selectedUserId + '/points/' + encodeURIComponent(entry.ledgerId) + '/reverse', { method: 'POST', body: JSON.stringify({ reason }) });
          showStatus('积分调整已撤销', 'ok');
          await Promise.all([loadLedger(selectedUserId), loadUsers(), loadAudit()]);
        }, true));
        body.appendChild(row);
      }
      ledgerDialog.showModal();
    }

    async function loadAudit() {
      const result = await api('/v1/admin/audit-log?limit=200');
      const body = document.querySelector('#audit-body');
      body.replaceChildren();
      for (const entry of result.entries) {
        const row = document.createElement('tr');
        addCell(row, formatDate(entry.createdAt));
        addCell(row, entry.actorId);
        addCell(row, entry.targetUserId);
        addCell(row, entry.action);
        addCell(row, String(entry.before) + ' → ' + String(entry.after));
        addCell(row, entry.reason);
        body.appendChild(row);
      }
    }

    async function loadAll() {
      sessionStorage.setItem('mymj-admin-token', tokenInput.value.trim());
      await Promise.all([loadKeys(), loadUsers(), loadAudit()]);
      showStatus('管理后台已连接', 'ok');
    }

    document.querySelector('#connect').addEventListener('click', () => loadAll().catch((error) => showStatus(error.message, 'error')));
    document.querySelector('#logout').addEventListener('click', () => { sessionStorage.removeItem('mymj-admin-token'); tokenInput.value = ''; showStatus('管理员令牌已清除'); });
    document.querySelector('#issue-form').addEventListener('submit', (event) => issueKeys(event).catch((error) => showStatus(error.message, 'error')));
    document.querySelector('#refresh-keys').addEventListener('click', () => loadKeys().catch((error) => showStatus(error.message, 'error')));
    document.querySelector('#user-search').addEventListener('submit', (event) => loadUsers(event).catch((error) => showStatus(error.message, 'error')));
    document.querySelector('#refresh-audit').addEventListener('click', () => loadAudit().catch((error) => showStatus(error.message, 'error')));
    document.querySelector('#close-ledger').addEventListener('click', () => ledgerDialog.close());
    document.querySelector('#copy-keys').addEventListener('click', async () => { await navigator.clipboard.writeText(document.querySelector('#issued').textContent); showStatus('密钥已复制到剪贴板', 'ok'); });

    if (tokenInput.value) loadAll().catch((error) => showStatus(error.message, 'error'));
  </script>
</body>
</html>`;
}
