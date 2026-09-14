// ===== Google Drive 雲端存檔（純前端 OAuth + Drive appDataFolder） =====
// This module deliberately sits beside the existing local save system. Local
// storage remains synchronous and authoritative while the user is playing;
// Google Drive is an explicit, manual whole-progress backup/sync destination.
(function (global) {
    'use strict';

    const DRIVE_SCOPE = 'https://www.googleapis.com/auth/drive.appdata';
    const DRIVE_API = 'https://www.googleapis.com/drive/v3';
    const DRIVE_UPLOAD_API = 'https://www.googleapis.com/upload/drive/v3/files';
    const CLOUD_FILE_NAME = 'idle-lineage-all-progress.json';
    const CLOUD_META_KEY = 'idle_lineage_google_drive_sync_v1';
    const GIS_SCRIPT_SRC = 'https://accounts.google.com/gsi/client';
    const FILE_FIELDS = 'id,name,modifiedTime,size,version,mimeType';

    const driveState = {
        accessToken: '',
        tokenExpiresAt: 0,
        tokenClient: null,
        tokenPromise: null,
        gisPromise: null,
        busy: false,
        syncSession: null,
        cloudFile: null,
        lastCloudEnvelope: null
    };

    function configClientId() {
        return String(global.IDLE_LINEAGE_GOOGLE_CLIENT_ID || '').trim();
    }

    function getEl(id) { return document.getElementById(id); }

    function escapeHtml(value) {
        return String(value == null ? '' : value)
            .replace(/&/g, '&amp;')
            .replace(/</g, '&lt;')
            .replace(/>/g, '&gt;')
            .replace(/"/g, '&quot;')
            .replace(/'/g, '&#39;');
    }

    function fmtNumber(value) {
        const n = Number(value);
        return Number.isFinite(n) ? Math.floor(n).toLocaleString('zh-TW') : '-';
    }

    function fmtTime(value) {
        if (!value) return '無資料';
        const d = new Date(value);
        return Number.isNaN(d.getTime()) ? String(value) : d.toLocaleString('zh-TW', { hour12: false });
    }

    function setText(id, value) {
        const el = getEl(id);
        if (el) el.textContent = String(value == null ? '' : value);
    }

    function setStatus(message, kind) {
        const el = getEl('cloud-drive-status');
        if (!el) return;
        el.textContent = message;
        el.classList.remove('is-ok', 'is-error', 'is-busy');
        if (kind) el.classList.add(kind);
    }

    function statusMessage() {
        if (!configClientId()) return 'Google 雲端：尚未設定 Client ID';
        if (driveState.busy) return 'Google 雲端：處理中…';
        if (driveState.accessToken && Date.now() < driveState.tokenExpiresAt) return 'Google 雲端：已連線';
        return 'Google 雲端：未登入';
    }

    function updateCloudUi() {
        setStatus(statusMessage(), driveState.busy ? 'is-busy' : (driveState.accessToken ? 'is-ok' : ''));
        const connected = !!driveState.accessToken && Date.now() < driveState.tokenExpiresAt;
        const configured = !!configClientId();
        const signIn = getEl('btn-google-drive-signin');
        const sync = getEl('btn-google-drive-sync');
        const signOut = getEl('btn-google-drive-signout');
        if (signIn) signIn.disabled = !configured || driveState.busy;
        if (sync) sync.disabled = !configured || driveState.busy;
        if (signOut) signOut.disabled = !connected || driveState.busy;
        const meta = readCloudMeta();
        setText('cloud-drive-last-sync', meta && meta.lastSyncAt ? '最後同步：' + fmtTime(meta.lastSyncAt) : '尚未同步');
    }

    function readCloudMeta() {
        try {
            const raw = localStorage.getItem(CLOUD_META_KEY);
            return raw ? JSON.parse(raw) : null;
        } catch (e) { return null; }
    }

    function writeCloudMeta(file, envelope) {
        const meta = {
            fileId: file && file.id || '',
            // version 是 Drive 檔案內容的修訂版本；下次同步會用它確認本機的基準是否仍是目前雲端版本。
            cloudVersion: file && file.version != null ? String(file.version) : '',
            fileModifiedTime: file && file.modifiedTime || '',
            cloudFingerprint: envelope && envelope.save ? snapshotFingerprint(envelope.save) : '',
            cloudSavedAt: envelope && envelope.cloudSavedAt || '',
            lastSyncAt: new Date().toISOString()
        };
        try { localStorage.setItem(CLOUD_META_KEY, JSON.stringify(meta)); } catch (e) {}
        updateCloudUi();
    }

    function gisReady() {
        return !!(global.google && global.google.accounts && global.google.accounts.oauth2);
    }

    function ensureGis() {
        if (gisReady()) return Promise.resolve();
        if (driveState.gisPromise) return driveState.gisPromise;
        driveState.gisPromise = new Promise(function (resolve, reject) {
            let script = document.querySelector('script[data-idle-lineage-google-gis]');
            if (!script) {
                script = document.createElement('script');
                script.src = GIS_SCRIPT_SRC;
                script.async = true;
                script.defer = true;
                script.dataset.idleLineageGoogleGis = '1';
                document.head.appendChild(script);
            }
            const started = Date.now();
            const timer = setInterval(function () {
                if (gisReady()) {
                    clearInterval(timer);
                    resolve();
                } else if (Date.now() - started > 15000) {
                    clearInterval(timer);
                    reject(new Error('Google 登入元件載入逾時，請確認網路連線或瀏覽器是否阻擋 Google。'));
                }
            }, 50);
        }).catch(function (error) {
            driveState.gisPromise = null;
            throw error;
        });
        return driveState.gisPromise;
    }

    function clearAccessToken() {
        driveState.accessToken = '';
        driveState.tokenExpiresAt = 0;
        updateCloudUi();
    }

    function getAccessToken(interactive) {
        if (!configClientId()) return Promise.reject(new Error('尚未設定 Google OAuth Client ID。'));
        if (driveState.accessToken && Date.now() < driveState.tokenExpiresAt - 60000) return Promise.resolve(driveState.accessToken);
        if (driveState.tokenPromise) return driveState.tokenPromise;
        driveState.tokenPromise = ensureGis().then(function () {
            return new Promise(function (resolve, reject) {
                let settled = false;
                function finish(fn, value) {
                    if (settled) return;
                    settled = true;
                    driveState.tokenPromise = null;
                    fn(value);
                }
                try {
                    if (!driveState.tokenClient) {
                        driveState.tokenClient = global.google.accounts.oauth2.initTokenClient({
                            client_id: configClientId(),
                            scope: DRIVE_SCOPE,
                            callback: function (response) {
                                if (!response || response.error || !response.access_token) {
                                    finish(reject, new Error((response && (response.error_description || response.error)) || 'Google 授權未完成。'));
                                    return;
                                }
                                driveState.accessToken = response.access_token;
                                driveState.tokenExpiresAt = Date.now() + (Number(response.expires_in) || 3600) * 1000;
                                updateCloudUi();
                                finish(resolve, driveState.accessToken);
                            },
                            error_callback: function (error) {
                                finish(reject, new Error((error && (error.message || error.type)) || 'Google 授權未完成。'));
                            }
                        });
                    }
                    driveState.tokenClient.requestAccessToken({ prompt: interactive ? 'consent' : '' });
                } catch (error) { finish(reject, error); }
            });
        }).catch(function (error) {
            driveState.tokenPromise = null;
            throw error;
        });
        return driveState.tokenPromise;
    }

    async function driveRequest(url, options, retried) {
        const token = await getAccessToken(false);
        const opts = Object.assign({}, options || {});
        opts.headers = Object.assign({}, opts.headers || {}, { Authorization: 'Bearer ' + token });
        let response;
        try { response = await fetch(url, opts); }
        catch (error) { throw new Error('無法連線到 Google Drive，請稍後再試。'); }
        if (response.status === 401 && !retried) {
            clearAccessToken();
            await getAccessToken(true);
            return driveRequest(url, options, true);
        }
        if (!response.ok) {
            let detail = '';
            try {
                const body = await response.json();
                detail = body && body.error && body.error.message ? body.error.message : '';
            } catch (e) {}
            if (response.status === 403 && /quota|storage/i.test(detail)) throw new Error('Google Drive 儲存空間或 API 配額不足。');
            if (response.status === 403) throw new Error('Google Drive 拒絕此操作，請重新登入並確認雲端存檔權限。');
            if (response.status === 404) throw new Error('Google Drive 存檔檔案不存在。');
            throw new Error('Google Drive 操作失敗（' + response.status + '）。' + (detail ? ' ' + detail : ''));
        }
        return response;
    }

    async function findCloudFile() {
        const query = "'appDataFolder' in parents and name = '" + CLOUD_FILE_NAME + "' and trashed = false";
        const params = new URLSearchParams({
            spaces: 'appDataFolder',
            q: query,
            pageSize: '10',
            orderBy: 'modifiedTime desc',
            fields: 'files(' + FILE_FIELDS + ')'
        });
        const response = await driveRequest(DRIVE_API + '/files?' + params.toString(), { method: 'GET' });
        const body = await response.json();
        return body.files && body.files.length ? body.files[0] : null;
    }

    function progressFormat() { return typeof ALL_PROGRESS_FORMAT !== 'undefined' ? ALL_PROGRESS_FORMAT : 'idle-lineage-all-save'; }
    function progressSchema() { return typeof ALL_PROGRESS_SCHEMA !== 'undefined' ? ALL_PROGRESS_SCHEMA : 1; }
    function gameVersion() { return typeof GAME_VERSION !== 'undefined' ? GAME_VERSION : 'unknown'; }

    function normalizeEnvelope(envelope) {
        if (!envelope || envelope.format !== progressFormat() || envelope.schema !== progressSchema() || !envelope.save) {
            throw new Error('雲端檔案不是支援的全部進度格式。');
        }
        if (typeof _allProgressValidate !== 'function') throw new Error('遊戲存檔驗證功能尚未載入。');
        return Object.assign({}, envelope, { save: _allProgressValidate(envelope.save) });
    }

    async function downloadCloudState() {
        const file = await findCloudFile();
        if (!file) return { file: null, envelope: null };
        const response = await driveRequest(DRIVE_API + '/files/' + encodeURIComponent(file.id) + '?alt=media', { method: 'GET' });
        let envelope;
        try { envelope = JSON.parse(await response.text()); }
        catch (e) { throw new Error('雲端存檔不是有效的 JSON。'); }
        return { file: file, envelope: normalizeEnvelope(envelope) };
    }

    function makeEnvelope(snapshot) {
        const now = new Date().toISOString();
        return {
            format: progressFormat(),
            schema: progressSchema(),
            version: gameVersion(),
            exportedAt: now,
            cloudSavedAt: now,
            save: snapshot
        };
    }

    // 比對只看遊戲邏輯資料；_roleEpoch 是防止舊分頁覆寫新角色的執行期世代碼，
    // 雲端驗證時會重新產生，不能把它算進「進度是否相同」的指紋。
    function comparisonCopy(snapshot) {
        if (snapshot == null) return snapshot;
        let copy;
        try { copy = JSON.parse(JSON.stringify(snapshot)); }
        catch (e) { return snapshot; }
        for (let slot = 1; slot <= 8; slot++) {
            const doc = copy.slots && copy.slots[String(slot)];
            const p = doc && doc.p;
            if (!p) continue;
            // 舊存檔可能沒有這些欄位；補成驗證器會使用的正規形式，避免舊資料產生假差異。
            if (typeof _allProgressRoleSeed === 'function') {
                try { p.enSeed = String(_allProgressRoleSeed(p, slot)); } catch (e) {}
            } else if (p.enSeed != null) p.enSeed = String(p.enSeed);
            if (!Array.isArray(p.allies)) p.allies = [];
        }
        // 血盟／潘朵拉的 updatedAt 是儲存容器的維護時間，不是遊戲進度。
        if (copy.shared && copy.shared.clan) delete copy.shared.clan.updatedAt;
        if (copy.shared && copy.shared.pandora) delete copy.shared.pandora.updatedAt;
        return copy;
    }

    function canonicalize(value, key) {
        if (Array.isArray(value)) return value.map(canonicalize);
        if (value && typeof value === 'object') {
            const result = {};
            Object.keys(value).sort().forEach(function (childKey) {
                if (childKey === '_roleEpoch') return;
                result[childKey] = canonicalize(value[childKey], childKey);
            });
            return result;
        }
        return value;
    }

    function snapshotFingerprint(snapshot) {
        try { return JSON.stringify(canonicalize(comparisonCopy(snapshot))); }
        catch (e) { return ''; }
    }

    function isEmptyPandoraState(value) {
        if (!value || typeof value !== 'object' || Array.isArray(value)) return false;
        const boards = Array.isArray(value.boards) ? value.boards : [];
        return Number(value.seq) === 0
            && Number(value.diamonds) === 0
            && Number(value.lastCheckBucket) === -1
            && Array.isArray(value.wanderers) && value.wanderers.length === 0
            && Array.isArray(value.nameHistory) && value.nameHistory.length === 0
            && boards.length === 3
            && boards.every(function (board) {
                return board && !board.contract && Number(board.cooldownUntil) === 0;
            });
    }

    // 潘朵拉尚未建立 localStorage 狀態時，匯出 API 會回傳帶隨機 seed 的預設物件，
    // 每次讀取都可能不同。若本機與雲端都還是完全空白狀態，沿用雲端 seed，
    // 讓它不會在每次同步時被誤認為進度變更，也不會無意義地改寫未來隨機序列。
    function alignEmptyPandoraSeed(local, cloud) {
        const localState = local && local.shared && local.shared.pandora;
        const cloudState = cloud && cloud.envelope && cloud.envelope.save
            && cloud.envelope.save.shared && cloud.envelope.save.shared.pandora;
        if (isEmptyPandoraState(localState) && isEmptyPandoraState(cloudState) && cloudState.seed) {
            localState.seed = cloudState.seed;
        }
    }

    function safeArray(value) { return Array.isArray(value) ? value : []; }

    function countDictionary(value) {
        if (!value || typeof value !== 'object' || Array.isArray(value)) return 0;
        return Object.keys(value).filter(function (key) { return !!value[key]; }).length;
    }

    function roleClassName(cls) {
        return {
            royal: '王族', knight: '騎士', mage: '法師', elf: '妖精', dark: '黑暗妖精',
            illusion: '幻術士', dragon: '龍騎士', warrior: '戰士'
        }[cls] || cls || '-';
    }

    function expPercent(player) {
        if (!player) return '-';
        const lv = Math.max(1, Number(player.lv) || 1);
        const exp = Math.max(0, Number(player.exp) || 0);
        let req = 0;
        try { if (typeof getExpReq === 'function') req = Number(getExpReq(lv)) || 0; } catch (e) {}
        if (!req || !Number.isFinite(req)) return '-';
        return Math.max(0, Math.min(100, exp / req * 100)).toFixed(2) + '%';
    }

    function roleSummary(doc, slot) {
        const p = doc && doc.p;
        if (!p || !p.cls) return { slot: slot, empty: true, name: '空', cls: '-', lv: '-', exp: '-', gold: '-', map: '-' };
        return {
            slot: slot,
            empty: false,
            name: p.name || '未命名',
            cls: roleClassName(p.cls),
            lv: Number(p.lv) || 1,
            exp: expPercent(p),
            gold: fmtNumber(p.gold),
            map: (doc.ms && doc.ms.current) || p.lastBattleMap || '-'
        };
    }

    function modeSummary(mode) {
        mode = mode || {};
        const wh = mode.warehouse || {};
        const pets = safeArray(mode.pets && mode.pets.roster);
        const collections = mode.collections || {};
        const collectionCounts = {};
        Object.keys(collections).forEach(function (key) { collectionCounts[key] = countDictionary(collections[key]); });
        return {
            fingerprint: snapshotFingerprint(mode),
            warehouseItems: safeArray(wh.items).length,
            warehouseGold: fmtNumber(wh.gold),
            pets: pets.length,
            collections: collectionCounts
        };
    }

    function progressSummary(snapshot, envelope) {
        const slots = {};
        let roleCount = 0;
        for (let slot = 1; slot <= 8; slot++) {
            const row = roleSummary(snapshot && snapshot.slots && snapshot.slots[String(slot)], slot);
            if (!row.empty) roleCount++;
            slots[String(slot)] = row;
        }
        const shared = snapshot && snapshot.shared || {};
        return {
            savedAt: envelope && (envelope.cloudSavedAt || envelope.exportedAt) || '',
            version: envelope && envelope.version || gameVersion(),
            fingerprint: snapshotFingerprint(snapshot),
            roleCount: roleCount,
            slots: slots,
            normal: modeSummary(shared.modes && shared.modes.normal),
            classic: modeSummary(shared.modes && shared.modes.classic),
            clanChangedKey: snapshotFingerprint(shared.clan),
            mercChangedKey: snapshotFingerprint(shared.merc),
            pandoraChangedKey: snapshotFingerprint(shared.pandora),
            antharasChangedKey: snapshotFingerprint(shared.antharas),
            autoSellChangedKey: snapshotFingerprint(shared.autoSell)
        };
    }

    function sameValue(a, b) { return String(a == null ? '' : a) === String(b == null ? '' : b); }

    function sameMode(a, b) {
        if (a && b && a.fingerprint && b.fingerprint) return sameValue(a.fingerprint, b.fingerprint);
        return sameValue(a && a.warehouseItems, b && b.warehouseItems)
            && sameValue(a && a.warehouseGold, b && b.warehouseGold)
            && sameValue(a && a.pets, b && b.pets)
            && JSON.stringify(a && a.collections || {}) === JSON.stringify(b && b.collections || {});
    }

    function summaryDiff(localSummary, cloudSummary) {
        const roleChanges = [];
        for (let slot = 1; slot <= 8; slot++) {
            const a = localSummary && localSummary.slots[String(slot)];
            const b = cloudSummary && cloudSummary.slots[String(slot)];
            const changed = !a || !b || a.empty !== b.empty || ['name', 'cls', 'lv', 'exp', 'gold', 'map'].some(function (key) { return !sameValue(a[key], b[key]); });
            if (changed) roleChanges.push(String(slot));
        }
        return {
            changed: !sameValue(localSummary && localSummary.fingerprint, cloudSummary && cloudSummary.fingerprint),
            roleChanges: roleChanges
        };
    }

    function hasMeaningfulSnapshot(snapshot) {
        const summary = progressSummary(snapshot, null);
        if (summary.roleCount > 0) return true;
        const shared = snapshot && snapshot.shared || {};
        const modes = shared.modes || {};
        const hasMode = ['normal', 'classic'].some(function (key) {
            const mode = modes[key] || {};
            return safeArray(mode.warehouse && mode.warehouse.items).length > 0
                || Number(mode.warehouse && mode.warehouse.gold) > 0
                || safeArray(mode.pets && mode.pets.roster).length > 0
                || Object.keys(mode.collections || {}).some(function (collection) { return countDictionary(mode.collections[collection]) > 0; });
        });
        // Clan/Pandora snapshots contain timestamps and default metadata even
        // before the first character exists. A role or meaningful inventory
        // entry is the reliable indication that the browser has a real save.
        return hasMode;
    }

    function localSnapshot() {
        if (typeof _allProgressGuard === 'function' && !_allProgressGuard('雲端同步', false)) return null;
        if (typeof _allProgressFlushCurrent === 'function' && !_allProgressFlushCurrent()) return null;
        if (typeof _allProgressCapture !== 'function') throw new Error('全部進度功能尚未載入。');
        return _allProgressCapture();
    }

    function renderRoleCell(row, side) {
        if (!row || row.empty) return '<span class="cloud-sync-empty">空</span>';
        return '<div class="cloud-sync-role-name">' + escapeHtml(row.name) + '</div>'
            + '<div>' + escapeHtml(row.cls) + '　Lv.' + escapeHtml(row.lv) + '　EXP ' + escapeHtml(row.exp) + '</div>'
            + '<div>金幣 ' + escapeHtml(row.gold) + '</div>'
            + '<div class="cloud-sync-map">地圖：' + escapeHtml(row.map) + '</div>';
    }

    function renderModeCell(summary) {
        summary = summary || {};
        const c = summary.collections || {};
        const collectionNames = ['卡片', '裝備', '道具', '遺物'];
        const labels = Object.keys(c).map(function (key, index) {
            return escapeHtml(collectionNames[index] || '其他') + ' ' + escapeHtml(c[key]);
        }).join('、') || '無';
        return '倉庫：' + escapeHtml(summary.warehouseItems || 0) + ' 項／金幣 ' + escapeHtml(summary.warehouseGold || '0')
            + '<br>寵物：' + escapeHtml(summary.pets || 0) + ' 隻'
            + '<br>圖鑑：' + labels;
    }

    function renderDiff(session) {
        const local = session.localSummary;
        const cloud = session.cloudSummary;
        const diff = summaryDiff(local, cloud);
        const localExists = !!session.localMeaningful;
        const cloudExists = !!session.cloudMeaningful;
        let html = '';
        html += '<div class="cloud-sync-file-meta"><span>本機：' + escapeHtml(local && local.savedAt ? fmtTime(local.savedAt) : '本次讀取') + '</span>'
            + '<span>雲端：' + escapeHtml(cloud && cloud.savedAt ? fmtTime(cloud.savedAt) : '沒有雲端存檔') + '</span></div>';
        html += '<div class="cloud-sync-file-meta"><span>版本：' + escapeHtml(local && local.version || gameVersion()) + '</span>'
            + '<span>雲端版本：' + escapeHtml(cloud && cloud.version || '-') + '</span></div>';
        if (session.reason === 'conflict' || session.reason === 'no-base') {
            const baseLabel = session.baseMeta && session.baseMeta.cloudVersion
                ? 'v' + session.baseMeta.cloudVersion
                : (session.baseMeta && session.baseMeta.fileModifiedTime ? fmtTime(session.baseMeta.fileModifiedTime) : '未記錄');
            html += '<div class="cloud-sync-notice">'
                + (session.reason === 'conflict'
                    ? (session.cloudFile
                        ? '雲端存檔已被其他裝置更新。本機是從較舊的雲端版本開始遊玩，請選擇要保留哪一邊。'
                        : '找不到本機上次同步的雲端存檔，可能已被其他裝置刪除，請確認是否要重建雲端檔案。')
                    : '找不到本機上次同步的雲端版本，無法安全判斷本機是否以目前雲端為基準，請選擇同步方向。')
                + '<br>上次同步基準：' + escapeHtml(baseLabel)
                + '　目前雲端：' + escapeHtml(cloudVersionLabel(session.cloudFile)) + '</div>';
        } else if (session.reason === 'safe-upload' || session.reason === 'create') {
            html += '<div class="cloud-sync-notice is-safe">目前雲端仍是上次同步版本，本機進度將安全上傳。</div>';
        }
        let headline = '兩邊沒有差異';
        if (session.reason === 'conflict') headline = '發現同步衝突，請選擇';
        else if (session.reason === 'no-base') headline = '無法確認同步基準，請選擇';
        else if (diff.changed) headline = '偵測到本機進度變更';
        html += '<div class="cloud-sync-overview"><span>本機角色：' + escapeHtml(local && local.roleCount || 0) + '/8</span><span>雲端角色：' + escapeHtml(cloud && cloud.roleCount || 0) + '/8</span>'
            + '<strong class="' + (diff.changed ? 'is-changed' : 'is-same') + '">' + headline + '</strong></div>';
        html += '<div class="cloud-sync-section-title">角色摘要</div><div class="cloud-sync-role-table">'
            + '<div class="cloud-sync-role-head"><span>存檔</span><span>本機</span><span>雲端</span></div>';
        for (let slot = 1; slot <= 8; slot++) {
            const key = String(slot);
            const changed = diff.roleChanges.includes(key);
            html += '<div class="cloud-sync-role-row ' + (changed ? 'is-changed' : '') + '"><b>第 ' + slot + ' 格</b><div>'
                + renderRoleCell(local && local.slots[key], 'local') + '</div><div>' + renderRoleCell(cloud && cloud.slots[key], 'cloud') + '</div></div>';
        }
        html += '</div><div class="cloud-sync-section-title">共用資料</div><div class="cloud-sync-shared-grid">';
        const sharedRows = [
            ['一般模式倉庫／寵物／圖鑑', renderModeCell(local && local.normal), renderModeCell(cloud && cloud.normal), !sameMode(local && local.normal, cloud && cloud.normal)],
            ['經典模式倉庫／寵物／圖鑑', renderModeCell(local && local.classic), renderModeCell(cloud && cloud.classic), !sameMode(local && local.classic, cloud && cloud.classic)],
            ['血盟', local && local.clanChangedKey ? '有資料' : '無資料', cloud && cloud.clanChangedKey ? '有資料' : '無資料', !sameValue(local && local.clanChangedKey, cloud && cloud.clanChangedKey)],
            ['傭兵', local && local.mercChangedKey ? '有資料' : '無資料', cloud && cloud.mercChangedKey ? '有資料' : '無資料', !sameValue(local && local.mercChangedKey, cloud && cloud.mercChangedKey)],
            ['潘朵拉／安塔瑞斯／自動販賣', '已納入全部進度', '已納入全部進度', !sameValue(local && local.pandoraChangedKey, cloud && cloud.pandoraChangedKey) || !sameValue(local && local.antharasChangedKey, cloud && cloud.antharasChangedKey) || !sameValue(local && local.autoSellChangedKey, cloud && cloud.autoSellChangedKey)]
        ];
        sharedRows.forEach(function (row) {
            html += '<div class="cloud-sync-shared-row ' + (row[3] ? 'is-changed' : '') + '"><b>' + escapeHtml(row[0]) + '</b><span>' + row[1] + '</span><span>' + row[2] + '</span></div>';
        });
        html += '</div>';
        setText('cloud-sync-title', 'Google 雲端同步');
        const body = getEl('cloud-sync-summary');
        if (body) body.innerHTML = html;
        const upload = getEl('cloud-sync-upload');
        const download = getEl('cloud-sync-download');
        const cancel = getEl('cloud-sync-cancel');
        const bothSame = localExists && cloudExists && session.contentSame;
        if (upload) {
            upload.disabled = !localExists || bothSame;
            upload.textContent = session.reason === 'conflict' || session.reason === 'no-base'
                ? '保留本機，覆蓋雲端'
                : (cloudExists ? '上傳本機，覆蓋雲端' : '上傳本機，建立雲端存檔');
        }
        if (download) {
            download.disabled = !cloudExists || bothSame;
            download.textContent = session.reason === 'conflict' || session.reason === 'no-base'
                ? '使用雲端，覆蓋本機'
                : (localExists ? '下載雲端，覆蓋本機' : '下載雲端到本機');
        }
        if (cancel) cancel.disabled = false;
        const modal = getEl('cloud-sync-modal');
        if (modal) modal.classList.remove('hidden');
    }

    function closeSyncDialog() {
        const modal = getEl('cloud-sync-modal');
        if (modal) modal.classList.add('hidden');
        driveState.syncSession = null;
        updateCloudUi();
    }

    function sameCloudFile(a, b) {
        if (!a && !b) return true;
        if (!a || !b) return false;
        if (String(a.id || '') !== String(b.id || '')) return false;
        // version 是主要判斷依據；舊回應若沒有 version，才退回 modifiedTime。
        if (a.version != null || b.version != null) {
            return String(a.version || '') !== '' && String(a.version || '') === String(b.version || '');
        }
        return String(a.modifiedTime || '') === String(b.modifiedTime || '');
    }

    function cloudVersionLabel(file) {
        if (!file) return '沒有雲端檔案';
        if (file.version != null && String(file.version) !== '') return 'v' + String(file.version);
        return file.modifiedTime ? fmtTime(file.modifiedTime) : '未知';
    }

    function cloudMetaMatches(meta, cloud) {
        if (!meta || !cloud || !cloud.file || !cloud.envelope) return false;
        if (String(meta.fileId || '') !== String(cloud.file.id || '')) return false;
        // 有版本資料時只接受完全相同的 Drive revision，避免不同檔案剛好有相同時間。
        if (meta.cloudVersion) {
            return cloud.file.version != null && String(meta.cloudVersion) === String(cloud.file.version);
        }
        // 舊版只記錄 modifiedTime；僅作相容用，成功同步後會補寫 cloudVersion。
        if (meta.fileModifiedTime && cloud.file.modifiedTime && String(meta.fileModifiedTime) === String(cloud.file.modifiedTime)) return true;
        return !!(meta.cloudFingerprint && String(meta.cloudFingerprint) === snapshotFingerprint(cloud.envelope.save));
    }

    function makeSyncSession(local, cloud, baseMeta) {
        alignEmptyPandoraSeed(local, cloud);
        const localEnvelope = makeEnvelope(local);
        const localFingerprint = snapshotFingerprint(local);
        const cloudFingerprint = cloud.envelope ? snapshotFingerprint(cloud.envelope.save) : '';
        const contentSame = !!cloud.envelope && localFingerprint === cloudFingerprint;
        const localMeaningful = hasMeaningfulSnapshot(local);
        const cloudExists = !!(cloud.file && cloud.envelope);
        let reason;

        // 雲端不存在時，只有從未有過同步基準才可直接建立檔案；若已有基準卻找不到
        // 原檔，代表檔案可能被其他裝置刪除，也必須交由使用者確認是否重建。
        if (!cloudExists) reason = baseMeta && baseMeta.fileId ? 'conflict' : (localMeaningful ? 'create' : 'empty');
        else if (contentSame) reason = 'same';
        // 雲端仍是本機上次成功同步的版本，代表本機只是從該版本繼續遊玩，可安全上傳。
        else if (cloudMetaMatches(baseMeta, cloud)) reason = 'safe-upload';
        // 有基準但雲端已換版＝其他裝置更新過；沒有基準則不能猜測本機的來源。
        else reason = baseMeta && baseMeta.fileId ? 'conflict' : 'no-base';

        return {
            mode: 'sync',
            local: local,
            cloud: cloud.envelope,
            cloudFile: cloud.file,
            baseMeta: baseMeta,
            reason: reason,
            localFingerprint: localFingerprint,
            localMeaningful: localMeaningful,
            cloudMeaningful: cloudExists,
            contentSame: contentSame,
            localSummary: progressSummary(local, localEnvelope),
            cloudSummary: cloud.envelope ? progressSummary(cloud.envelope.save, cloud.envelope) : null
        };
    }

    function showSyncReview(local, cloud, baseMeta, reasonOverride) {
        const session = makeSyncSession(local, cloud, baseMeta);
        if (reasonOverride) session.reason = reasonOverride;
        driveState.cloudFile = cloud.file;
        driveState.lastCloudEnvelope = cloud.envelope;
        driveState.syncSession = session;
        driveState.busy = false;
        updateCloudUi();
        if (session.reason === 'conflict' || session.reason === 'no-base') {
            setStatus('Google 雲端：需要選擇同步方向', 'is-error');
        }
        renderDiff(session);
        return session;
    }

    // 按下覆蓋方向後重新讀取一次，避免使用者開著選擇視窗時另一台電腦又先寫入。
    // 任一本機／雲端版本改變都不直接覆蓋，而是以最新資料重新顯示衝突選擇。
    async function refreshForAction(session) {
        let nowLocal;
        try { nowLocal = localSnapshot(); }
        catch (error) { throw error; }
        if (!nowLocal) {
            driveState.busy = false;
            updateCloudUi();
            return null;
        }
        const nowCloud = await downloadCloudState();
        alignEmptyPandoraSeed(nowLocal, nowCloud);
        const localChanged = snapshotFingerprint(nowLocal) !== session.localFingerprint;
        const cloudChanged = !sameCloudFile(nowCloud.file, session.cloudFile);
        if (localChanged || cloudChanged) {
            showSyncReview(nowLocal, nowCloud, session.baseMeta, 'conflict');
            setStatus('Google 雲端：資料已更新，請重新比較', 'is-error');
            alert('本機或雲端資料在比較期間發生變更，為避免覆蓋新進度，已重新讀取最新資料。');
            return null;
        }
        return { local: nowLocal, cloud: nowCloud };
    }

    async function uploadCloudFile(envelope, existingFile) {
        const data = JSON.stringify(envelope);
        const fields = encodeURIComponent(FILE_FIELDS);
        if (existingFile && existingFile.id) {
            const response = await driveRequest(DRIVE_UPLOAD_API + '/' + encodeURIComponent(existingFile.id) + '?uploadType=media&fields=' + fields, {
                method: 'PATCH',
                headers: { 'Content-Type': 'application/json; charset=UTF-8' },
                body: data
            });
            return response.json();
        }
        const boundary = 'idleLineageBoundary' + Math.random().toString(16).slice(2);
        const metadata = JSON.stringify({ name: CLOUD_FILE_NAME, parents: ['appDataFolder'], mimeType: 'application/json' });
        const body = '--' + boundary + '\r\n'
            + 'Content-Type: application/json; charset=UTF-8\r\n\r\n' + metadata + '\r\n'
            + '--' + boundary + '\r\n'
            + 'Content-Type: application/json\r\n\r\n' + data + '\r\n'
            + '--' + boundary + '--';
        const response = await driveRequest(DRIVE_UPLOAD_API + '?uploadType=multipart&fields=' + fields, {
            method: 'POST',
            headers: { 'Content-Type': 'multipart/related; boundary=' + boundary },
            body: body
        });
        return response.json();
    }

    function resetRuntimeAfterRestore() {
        try {
            if (typeof _uiConfigReady !== 'undefined') _uiConfigReady = false;
            if (typeof freshPlayerState === 'function' && typeof player !== 'undefined') player = freshPlayerState();
            if (typeof freshMapState === 'function' && typeof mapState !== 'undefined') mapState = freshMapState();
            if (typeof state !== 'undefined' && state) state.running = false;
            if (typeof _roleSessionForget === 'function') _roleSessionForget();
            if (typeof _petRoster !== 'undefined') _petRoster = [];
            if (typeof _petRosterKey !== 'undefined') _petRosterKey = null;
            if (typeof _petRosterDirty !== 'undefined') _petRosterDirty = false;
            if (typeof _petReleasedUids !== 'undefined') _petReleasedUids = {};
            if (typeof _petPendingAddUids !== 'undefined') _petPendingAddUids = {};
            if (typeof _whLoadUids !== 'undefined') _whLoadUids = null;
            if (typeof _whLoadOk !== 'undefined') _whLoadOk = true;
            if (typeof _mercEmploymentBootKey !== 'undefined') _mercEmploymentBootKey = '';
            if (typeof _mercEmploymentLeaderSig !== 'undefined') _mercEmploymentLeaderSig = '';
            if (typeof _mercEmploymentLeaderRole !== 'undefined') _mercEmploymentLeaderRole = '';
            if (typeof _mercEmployerCache !== 'undefined') _mercEmployerCache = { key: '', at: 0, value: null };
        } catch (error) { try { console.warn('[cloud restore runtime reset]', error); } catch (e) {} }
        try { if (typeof renderLoadSelect === 'function') renderLoadSelect(); } catch (error) {}
    }

    // 將本機進度上傳到目前雲端檔案。force=true 只代表使用者已在衝突畫面
    // 明確選擇「保留本機」；即使如此，refreshForAction 仍會先確認選擇後雲端沒有再次換版。
    async function uploadSession(session, force) {
        if (!session || driveState.busy || !session.localMeaningful) return;
        driveState.busy = true;
        updateCloudUi();
        setStatus('Google 雲端：正在上傳…', 'is-busy');
        try {
            const fresh = await refreshForAction(session);
            if (!fresh) return;
            // 安全上傳必須同時滿足：目前檔案仍是比較時看到的檔案，且仍等於本機
            // 上次成功同步的基準。若基準已失效，只能回到衝突選擇，不能默默覆蓋。
            if (!force && fresh.cloud.file && !cloudMetaMatches(session.baseMeta, fresh.cloud)) {
                showSyncReview(fresh.local, fresh.cloud, session.baseMeta, 'conflict');
                setStatus('Google 雲端：需要選擇同步方向', 'is-error');
                alert('雲端存檔已不是本機上次同步的版本，為避免覆蓋其他裝置的新進度，請重新選擇同步方向。');
                return;
            }
            const envelope = makeEnvelope(fresh.local);
            const file = await uploadCloudFile(envelope, fresh.cloud.file);
            if (!file || !file.id) throw new Error('Google Drive 未回傳有效的雲端檔案。');
            driveState.cloudFile = file;
            driveState.lastCloudEnvelope = envelope;
            driveState.busy = false;
            // 上傳成功才更新基準；衝突未解決或上傳失敗時保留舊基準，避免下次誤判可直接覆蓋。
            writeCloudMeta(file, envelope);
            closeSyncDialog();
            setStatus('Google 雲端：已同步', 'is-ok');
            alert('全部進度已同步到 Google 雲端。');
        } catch (error) {
            driveState.busy = false;
            updateCloudUi();
            setStatus('Google 雲端：上傳失敗', 'is-error');
            alert(error && error.message ? error.message : 'Google 雲端上傳失敗，您的本機資料未被刪除。');
        }
    }

    // 單一「雲端同步」入口：先取得本機／雲端快照，再用本機保存的上一個雲端
    // revision 判斷是否能自動上傳。只有雲端已被別台裝置更新，或沒有可用基準時，
    // 才開啟方向選擇視窗交給使用者決定。
    async function beginSync() {
        if (driveState.busy) return;
        driveState.busy = true;
        updateCloudUi();
        setStatus('Google 雲端：正在讀取…', 'is-busy');
        try {
            await getAccessToken(!driveState.accessToken);
            const local = localSnapshot();
            if (!local) {
                driveState.busy = false;
                updateCloudUi();
                return;
            }
            const cloud = await downloadCloudState();
            const session = makeSyncSession(local, cloud, readCloudMeta());
            driveState.cloudFile = cloud.file;
            driveState.lastCloudEnvelope = cloud.envelope;
            driveState.syncSession = session;
            driveState.busy = false;
            updateCloudUi();

            if (session.reason === 'same') {
                // 即使內容沒變，也把目前 revision 寫成下一次的比較基準；這能補上
                // 舊版尚未記錄 version 的裝置資料。
                writeCloudMeta(cloud.file, cloud.envelope);
                setStatus('Google 雲端：已同步', 'is-ok');
                return;
            }
            if (session.reason === 'safe-upload' || session.reason === 'create') {
                await uploadSession(session, false);
                return;
            }
            if (session.reason === 'empty') {
                setStatus('Google 雲端：沒有需要同步的進度', 'is-ok');
                return;
            }
            showSyncReview(local, cloud, session.baseMeta, session.reason);
        } catch (error) {
            driveState.busy = false;
            updateCloudUi();
            setStatus('Google 雲端：操作失敗', 'is-error');
            alert(error && error.message ? error.message : 'Google 雲端同步失敗。');
        }
    }

    async function syncUpload() {
        const session = driveState.syncSession;
        if (!session || driveState.busy || !session.localMeaningful) return;
        const conflictChoice = session.reason === 'conflict' || session.reason === 'no-base';
        if (conflictChoice && !confirm('雲端可能有其他裝置的新進度。\n\n確定要保留本機進度並覆蓋 Google 雲端存檔嗎？')) return;
        await uploadSession(session, conflictChoice);
    }

    async function syncDownload() {
        const session = driveState.syncSession;
        if (!session || driveState.busy || !session.cloud) return;
        if (!confirm('確定要使用 Google 雲端存檔覆蓋本機全部進度嗎？')) return;
        driveState.busy = true;
        updateCloudUi();
        setStatus('Google 雲端：正在下載…', 'is-busy');
        try {
            const fresh = await refreshForAction(session);
            if (!fresh) return;
            if (!fresh.cloud.envelope) throw new Error('雲端存檔已不存在，請重新比較。');
            if (typeof _allProgressRestore !== 'function') throw new Error('全部進度還原功能尚未載入。');
            const result = _allProgressRestore(fresh.cloud.envelope.save);
            if (!result || !result.ok) throw new Error(result && result.error || '本機資料還原失敗。');
            resetRuntimeAfterRestore();
            driveState.busy = false;
            // 下載成功後，這個雲端 revision 就成為本機新的同步基準。
            writeCloudMeta(fresh.cloud.file, fresh.cloud.envelope);
            closeSyncDialog();
            setStatus('Google 雲端：已同步', 'is-ok');
            alert('Google 雲端全部進度已下載並套用到本機。');
        } catch (error) {
            driveState.busy = false;
            updateCloudUi();
            setStatus('Google 雲端：下載失敗', 'is-error');
            alert(error && error.message ? error.message : 'Google 雲端下載失敗；本機資料已保留。');
        }
    }

    async function signIn() {
        if (driveState.busy) return;
        driveState.busy = true;
        updateCloudUi();
        setStatus('Google 雲端：正在登入…', 'is-busy');
        try {
            await getAccessToken(true);
            driveState.busy = false;
            updateCloudUi();
            setStatus('Google 雲端：已連線', 'is-ok');
        } catch (error) {
            driveState.busy = false;
            updateCloudUi();
            setStatus('Google 雲端：登入失敗', 'is-error');
            alert(error && error.message ? error.message : 'Google 登入未完成。');
        }
    }

    function signOut() {
        if (driveState.accessToken && global.google && global.google.accounts && global.google.accounts.oauth2) {
            try { global.google.accounts.oauth2.revoke(driveState.accessToken, function () {}); } catch (e) {}
        }
        clearAccessToken();
        driveState.cloudFile = null;
        driveState.lastCloudEnvelope = null;
        closeSyncDialog();
        setStatus(configClientId() ? 'Google 雲端：未登入' : 'Google 雲端：尚未設定 Client ID', '');
    }

    global.driveSignIn = signIn;
    global.driveSignOut = signOut;
    global.driveCloudSync = beginSync;
    global.cloudSyncCancel = closeSyncDialog;
    global.cloudSyncUpload = syncUpload;
    global.cloudSyncDownload = syncDownload;

    updateCloudUi();
})(window);
