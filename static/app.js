const $ = (sel) => document.querySelector(sel);
const $$ = (sel) => document.querySelectorAll(sel);

let dirHandle = null;       // FileSystemDirectoryHandle
let currentEntries = [];    // { name, kind, handle }
let currentMode = 'search_replace';
let undoStack = [];         // [{ ops: [{ oldName, newName }] }]
let debounceTimer = null;

// ══════════════════════════════════════════
//  Init
// ══════════════════════════════════════════
document.addEventListener('DOMContentLoaded', () => {
    if (!('showDirectoryPicker' in window)) {
        $('#folder-list').innerHTML = `<p style="padding:16px;color:var(--red)">
            Ce navigateur ne supporte pas l'API File System Access.<br>
            Utilisez <strong>Chrome</strong> ou <strong>Edge</strong>.
        </p>`;
        return;
    }

    $('#btn-browse').addEventListener('click', pickDirectory);
    $('#btn-rename').addEventListener('click', executeRename);
    $('#btn-undo').addEventListener('click', undoLast);
    $('#progress-close').addEventListener('click', progressClose);

    $$('.tab').forEach(tab => {
        tab.addEventListener('click', () => {
            $$('.tab').forEach(t => t.classList.remove('active'));
            tab.classList.add('active');
            currentMode = tab.dataset.mode;
            $$('.rule-form').forEach(f => f.classList.add('hidden'));
            $(`#form-${currentMode}`).classList.remove('hidden');
            schedulePreview();
        });
    });

    $$('.rule-form input, .rule-form select').forEach(el => {
        el.addEventListener('input', schedulePreview);
    });
});

function schedulePreview() {
    clearTimeout(debounceTimer);
    debounceTimer = setTimeout(refreshPreview, 100);
}

// ══════════════════════════════════════════
//  File System Access API
// ══════════════════════════════════════════
async function pickDirectory() {
    try {
        dirHandle = await window.showDirectoryPicker({ mode: 'readwrite' });
        await loadEntries();
    } catch (e) {
        if (e.name !== 'AbortError') toast(e.message, 'error');
    }
}

async function loadEntries() {
    if (!dirHandle) return;
    currentEntries = [];

    for await (const [name, handle] of dirHandle.entries()) {
        currentEntries.push({ name, kind: handle.kind, handle });
    }

    currentEntries.sort((a, b) => {
        if (a.kind !== b.kind) return a.kind === 'directory' ? -1 : 1;
        return a.name.toLowerCase().localeCompare(b.name.toLowerCase());
    });

    $('#folder-list').style.display = '';
    $('#folder-info').style.display = '';
    renderBrowser();
    renderBreadcrumb();
    refreshPreview();
}

function renderBrowser() {
    const list = $('#folder-list');
    const dirs = currentEntries.filter(e => e.kind === 'directory');
    const files = currentEntries.filter(e => e.kind === 'file');

    $('#file-count').textContent = `${files.length} fichier(s), ${dirs.length} dossier(s)`;
    $('#selected-path').textContent = dirHandle ? dirHandle.name : '';

    if (currentEntries.length === 0) {
        list.innerHTML = '<p style="padding:12px;color:var(--dim)">Dossier vide</p>';
        return;
    }

    let html = '';

    dirs.forEach(d => {
        html += `<button class="folder-item" data-name="${esc(d.name)}">
            <span class="folder-icon">\u{1F4C1}</span>
            <span class="folder-name">${esc(d.name)}</span>
        </button>`;
    });

    files.forEach(f => {
        html += `<div class="folder-item" style="cursor:default;opacity:.45">
            <span class="folder-icon" style="color:var(--dim)">\u{1F4C4}</span>
            <span class="folder-name">${esc(f.name)}</span>
        </div>`;
    });

    list.innerHTML = html;

    list.querySelectorAll('button.folder-item').forEach(btn => {
        btn.addEventListener('click', async () => {
            const name = btn.dataset.name;
            try {
                dirHandle = await dirHandle.getDirectoryHandle(name);
                await loadEntries();
            } catch (e) {
                toast(e.message, 'error');
            }
        });
    });
}

function renderBreadcrumb() {
    const bc = $('#breadcrumb');
    if (!dirHandle) {
        bc.innerHTML = '<span class="breadcrumb-item current">Aucun dossier</span>';
        return;
    }
    bc.innerHTML = `<span class="breadcrumb-item current">\u{1F4C1} ${esc(dirHandle.name)}</span>`;
}

// ══════════════════════════════════════════
//  Rename Engine (client-side port of Rust)
// ══════════════════════════════════════════
function splitNameExt(filename) {
    const dot = filename.lastIndexOf('.');
    if (dot > 0) return [filename.slice(0, dot), filename.slice(dot + 1)];
    return [filename, ''];
}

function splitWords(s) {
    const words = [];
    let current = '';
    for (const ch of s) {
        if ('_- .'.includes(ch)) {
            if (current) { words.push(current); current = ''; }
        } else if (ch === ch.toUpperCase() && ch !== ch.toLowerCase() && current && current.slice(-1) === current.slice(-1).toLowerCase() && current.slice(-1) !== current.slice(-1).toUpperCase()) {
            words.push(current); current = ch;
        } else {
            current += ch;
        }
    }
    if (current) words.push(current);
    return words;
}

function toTitleCase(s) {
    return splitWords(s).map(w => w.charAt(0).toUpperCase() + w.slice(1).toLowerCase()).join(' ');
}
function toCamelCase(s) {
    return splitWords(s).map((w, i) => i === 0 ? w.toLowerCase() : w.charAt(0).toUpperCase() + w.slice(1).toLowerCase()).join('');
}
function toSnakeCase(s) { return splitWords(s).map(w => w.toLowerCase()).join('_'); }
function toKebabCase(s) { return splitWords(s).map(w => w.toLowerCase()).join('-'); }

function applyCase(stem, caseType) {
    switch (caseType) {
        case 'upper': return stem.toUpperCase();
        case 'lower': return stem.toLowerCase();
        case 'title': return toTitleCase(stem);
        case 'camel': return toCamelCase(stem);
        case 'snake': return toSnakeCase(stem);
        case 'kebab': return toKebabCase(stem);
    }
    return stem;
}

function repadNumbers(stem, width) {
    return stem.replace(/\d+/g, match => {
        const num = parseInt(match, 10);
        return String(num).padStart(width, '0');
    });
}

function autoDetectPadding(filenames) {
    let max = 0;
    for (const name of filenames) {
        const [stem] = splitNameExt(name);
        for (const match of stem.matchAll(/\d+/g)) {
            const val = parseInt(match[0], 10);
            const needed = val === 0 ? 1 : Math.floor(Math.log10(val)) + 1;
            if (needed > max) max = needed;
        }
    }
    return max;
}

function buildRule() {
    switch (currentMode) {
        case 'search_replace':
            return { mode: 'search_replace', search: $('#sr-search').value, replace: $('#sr-replace').value };
        case 'regex':
            return { mode: 'regex', pattern: $('#re-pattern').value, replace: $('#re-replace').value };
        case 'prefix_suffix':
            return { mode: 'prefix_suffix', prefix: $('#ps-prefix').value, suffix: $('#ps-suffix').value };
        case 'numbering':
            return {
                mode: 'numbering',
                start: parseInt($('#num-start').value) || 1,
                step: parseInt($('#num-step').value) || 1,
                padding: parseInt($('#num-padding').value) || 3,
                position: $('#num-position').value,
                separator: $('#num-separator').value,
            };
        case 'case':
            return { mode: 'case', case_type: $('#case-type').value };
        case 'repad':
            return { mode: 'repad', padding: parseInt($('#repad-padding').value) || 0 };
        case 'segments':
            return {
                mode: 'segments',
                separator: $('#seg-separator').value,
                keep: $('#seg-keep').value,
                join: $('#seg-join').value,
                append: $('#seg-append').value,
                cycle: $('#seg-cycle').value,
                group_size: Math.max(1, parseInt($('#seg-group').value) || 1),
            };
    }
}

function parseKeepRange(spec, total) {
    const trimmed = (spec || '').trim();
    if (!trimmed) return [...Array(total).keys()];
    const out = [];
    for (const partRaw of trimmed.split(',')) {
        const part = partRaw.trim();
        if (!part) continue;
        const dash = part.indexOf('-');
        if (dash >= 0) {
            const a = part.slice(0, dash).trim();
            const b = part.slice(dash + 1).trim();
            const start = a === '' ? 1 : parseInt(a, 10);
            const end = b === '' ? total : parseInt(b, 10);
            if (isNaN(start) || isNaN(end)) continue;
            const s = Math.max(0, start - 1);
            const e = Math.min(total - 1, end - 1);
            for (let i = s; i <= e; i++) out.push(i);
        } else {
            const n = parseInt(part, 10);
            if (!isNaN(n)) {
                const i = n - 1;
                if (i >= 0 && i < total) out.push(i);
            }
        }
    }
    return out;
}

function applySegments(stem, rule, index) {
    const sep = rule.separator || '_';
    const segments = stem.split(sep);
    const indices = parseKeepRange(rule.keep, segments.length);
    const joinStr = rule.join || sep;
    const kept = indices.map(i => segments[i]).filter(s => s !== undefined);

    const cycleItems = (rule.cycle || '')
        .split(',')
        .map(s => s.trim())
        .filter(Boolean);
    const g = Math.max(1, rule.group_size || 1);
    const expanded = cycleItems.flatMap(v => Array(g).fill(v));

    let cycleValue = '';
    let counterValue = index;
    if (expanded.length > 0) {
        const L = expanded.length;
        const pos = index % L;
        const round = Math.floor(index / L);
        cycleValue = expanded[pos];
        let occAtPos = 0;
        for (let k = 0; k <= pos; k++) if (expanded[k] === cycleValue) occAtPos++;
        const totalInCycle = expanded.filter(v => v === cycleValue).length;
        counterValue = round * totalInCycle + occAtPos - 1;
    }

    return kept.join(joinStr) + expandPlaceholders(rule.append || '', counterValue, cycleValue);
}

function expandPlaceholders(s, counter, cycleValue) {
    return s
        .replace(/#+/g, run => String(counter + 1).padStart(run.length, '0'))
        .replace(/@/g, cycleValue);
}

function computePreviews(filenames, rule) {
    let repadWidth = 0;
    if (rule.mode === 'repad') {
        repadWidth = rule.padding === 0 ? autoDetectPadding(filenames) : rule.padding;
    }

    return filenames.map((name, i) => {
        const [stem, ext] = splitNameExt(name);
        let newStem;

        switch (rule.mode) {
            case 'search_replace':
                newStem = stem.split(rule.search).join(rule.replace);
                break;
            case 'regex': {
                const re = new RegExp(rule.pattern, 'g');
                newStem = stem.replace(re, rule.replace);
                break;
            }
            case 'prefix_suffix':
                newStem = rule.prefix + stem + rule.suffix;
                break;
            case 'numbering': {
                const num = rule.start + i * rule.step;
                const numStr = String(num).padStart(rule.padding, '0');
                newStem = rule.position === 'prefix'
                    ? numStr + rule.separator + stem
                    : stem + rule.separator + numStr;
                break;
            }
            case 'case':
                newStem = applyCase(stem, rule.case_type);
                break;
            case 'repad':
                newStem = repadNumbers(stem, repadWidth);
                break;
            case 'segments':
                newStem = applySegments(stem, rule, i);
                break;
            default:
                newStem = stem;
        }

        const renamed = ext ? `${newStem}.${ext}` : newStem;
        return { original: name, renamed, changed: name !== renamed };
    });
}

// ══════════════════════════════════════════
//  Preview
// ══════════════════════════════════════════
function refreshPreview() {
    const list = $('#preview-list');
    const filenames = currentEntries.filter(e => e.kind === 'file').map(e => e.name);

    if (!dirHandle || filenames.length === 0) {
        list.innerHTML = '<p style="padding:12px;color:var(--dim)">Aucun fichier dans ce dossier</p>';
        $('#btn-rename').disabled = true;
        $('#changes-count').textContent = '0 modifications';
        $('#changes-count').className = 'badge';
        return;
    }

    const rule = buildRule();
    let previews;
    try {
        previews = computePreviews(filenames, rule);
    } catch (e) {
        list.innerHTML = `<p style="padding:12px;color:var(--red)">${esc(e.message)}</p>`;
        $('#btn-rename').disabled = true;
        return;
    }

    const changedCount = previews.filter(p => p.changed).length;
    $('#changes-count').textContent = `${changedCount} modification(s)`;
    $('#changes-count').className = changedCount > 0 ? 'badge has-changes' : 'badge';
    $('#btn-rename').disabled = changedCount === 0;

    let html = '';
    previews.forEach(p => {
        const cls = p.changed ? 'changed' : 'unchanged';
        html += `<div class="preview-item ${cls}">
            <span class="old-name">${esc(p.original)}</span>
            <span class="arrow">${p.changed ? '\u2192' : ''}</span>
            <span class="new-name">${p.changed ? esc(p.renamed) : ''}</span>
        </div>`;
    });
    list.innerHTML = html;
}

// ══════════════════════════════════════════
//  Progress modal
// ══════════════════════════════════════════
function progressOpen(total) {
    $('#progress-title').textContent = 'Renommage en cours';
    $('#progress-file').textContent = 'Preparation...';
    $('#progress-count').textContent = `0 / ${total}`;
    $('#progress-percent').textContent = '0%';
    $('#progress-bar-fill').style.width = '0%';
    $('#progress-bar-fill').className = 'progress-bar-fill';
    $('#progress-result').classList.add('hidden');
    $('#progress-result').className = 'progress-result hidden';
    $('#progress-close').classList.add('hidden');
    $('#progress-modal').classList.remove('hidden');
}

function progressUpdate(done, total, currentFile) {
    const pct = total === 0 ? 0 : Math.round((done / total) * 100);
    $('#progress-bar-fill').style.width = pct + '%';
    $('#progress-count').textContent = `${done} / ${total}`;
    $('#progress-percent').textContent = pct + '%';
    if (currentFile) $('#progress-file').textContent = currentFile;
}

function progressFinish(renamed, total, errors) {
    const fill = $('#progress-bar-fill');
    const result = $('#progress-result');
    const hasErrors = errors.length > 0;

    if (hasErrors) {
        $('#progress-title').textContent = 'Termine avec des erreurs';
        fill.classList.add('error');
        result.className = 'progress-result error';
        result.innerHTML = `${renamed} renomme(s), ${errors.length} erreur(s)<br><span style="color:var(--muted);font-size:11px">Voir la console pour le detail</span>`;
    } else {
        $('#progress-title').textContent = 'Renommage termine';
        $('#progress-file').textContent = '\u2713 Tous les fichiers ont ete renommes';
        fill.classList.add('success');
        result.className = 'progress-result success';
        result.textContent = `\u2713 ${renamed} fichier(s) renomme(s) avec succes`;
    }
    $('#progress-close').classList.remove('hidden');
}

function progressClose() {
    $('#progress-modal').classList.add('hidden');
}

// ══════════════════════════════════════════
//  Execute Rename — native handle.move(), metadata-only
// ══════════════════════════════════════════
async function executeRename() {
    const filenames = currentEntries.filter(e => e.kind === 'file').map(e => e.name);
    const rule = buildRule();
    const previews = computePreviews(filenames, rule).filter(p => p.changed);

    if (previews.length === 0) return;

    const entryByName = new Map(currentEntries.map(e => [e.name, e]));
    const total = previews.length;

    progressOpen(total);

    let renamed = 0;
    let errors = [];
    let ops = [];

    for (let i = 0; i < previews.length; i++) {
        const p = previews[i];
        progressUpdate(i, total, p.original);
        await new Promise(r => requestAnimationFrame(r));

        try {
            try {
                await dirHandle.getFileHandle(p.renamed);
                errors.push(`${p.original} : "${p.renamed}" existe deja`);
                continue;
            } catch { /* good, target doesn't exist */ }

            const entry = entryByName.get(p.original);
            if (!entry || !entry.handle.move) {
                throw new Error('handle.move() non disponible — mets a jour Chrome/Edge (v111+)');
            }
            await entry.handle.move(p.renamed);

            renamed++;
            ops.push({ oldName: p.original, newName: p.renamed });
        } catch (e) {
            errors.push(`${p.original} : ${e.message}`);
        }
    }

    progressUpdate(total, total, '');

    if (ops.length > 0) {
        undoStack.push({ ops });
        $('#btn-undo').disabled = false;
    }

    if (errors.length > 0) console.warn('Erreurs:', errors);

    progressFinish(renamed, total, errors);
    await loadEntries();
}

// ══════════════════════════════════════════
//  Undo
// ══════════════════════════════════════════
async function undoLast() {
    if (undoStack.length === 0) return;
    const record = undoStack.pop();
    let restored = 0;

    for (const op of [...record.ops].reverse()) {
        try {
            const handle = await dirHandle.getFileHandle(op.newName);
            if (!handle.move) throw new Error('handle.move() non disponible');
            await handle.move(op.oldName);
            restored++;
        } catch (e) {
            toast(`Erreur undo ${op.newName}: ${e.message}`, 'error');
        }
    }

    toast(`Annulation reussie (${restored} fichier(s))`, 'info');
    $('#btn-undo').disabled = undoStack.length === 0;
    await loadEntries();
}

// ══════════════════════════════════════════
//  Toast & Utils
// ══════════════════════════════════════════
function toast(msg, type = 'info') {
    const el = $('#toast');
    el.textContent = msg;
    el.className = `toast ${type}`;
    setTimeout(() => el.classList.add('hidden'), 3500);
}

function esc(s) {
    const d = document.createElement('div');
    d.textContent = s;
    return d.innerHTML;
}
