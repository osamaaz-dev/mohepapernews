/* قالب ورقة القرارات
   ─ صفحات متعددة (PDF / صور) ← كل صفحة تُوضع داخل القالب
   ─ محاذاة تلقائية عند الرفع (ملاءمة / ملء / عرض / قص الهوامش) ثم تعديل المستخدم
   ─ تحريك بالإصبع/الماوس + قرص بإصبعين + عجلة الماوس + شريط تكبير
   ─ تحميل صفحة واحدة أو كل الصفحات (ZIP) أو مشاركة على الموبايل
*/
(() => {
    'use strict';

    /* ═════════════ إعدادات ═════════════ */
    const PDFJS_SRC = 'https://cdnjs.cloudflare.com/ajax/libs/pdf.js/3.11.174/pdf.min.js';
    const PDFJS_WORKER = 'https://cdnjs.cloudflare.com/ajax/libs/pdf.js/3.11.174/pdf.worker.min.js';
    const ZMIN = 0.25, ZMAX = 6;             // حدود التكبير نسبةً إلى «ملاءمة الصفحة»
    const MAX_PAGES = 60;                    // أقصى عدد صفحات في الجلسة
    const PIXEL_BUDGET = 40e6;               // مجموع بكسلات كل الصفحات في الذاكرة
    const PAGE_PX_MAX = 4.5e6, PAGE_PX_MIN = 0.9e6;
    const IMAGE_PX_MAX = 6e6;
    const LS_TEMPLATE = 'paper.template', LS_TIP = 'paper.tip', LS_TG = 'paper.telegram';

    /* ═════════════ عناصر الصفحة ═════════════ */
    const $ = (id) => document.getElementById(id);
    const el = {
        stage: $('stage'), panel: $('panel'), frame: $('frame'), canvas: $('mainCanvas'), wrap: $('canvasWrap'),
        cta: $('emptyCta'), busy: $('busy'), busyText: $('busyText'), tip: $('gestureTip'), toast: $('toast'),
        pager: $('pager'), pagerText: $('pagerText'), prev: $('prevPage'), next: $('nextPage'),
        zoomSlider: $('zoomSlider'), zoomValue: $('zoomValue'), zoomIn: $('zoomIn'), zoomOut: $('zoomOut'),
        rotSlider: $('rotSlider'), rotValue: $('rotValue'), rotLeft: $('rotLeft'), rotRight: $('rotRight'),
        fileInput: $('fileInput'), dropzone: $('dropzone'), summary: $('fileSummary'), fsName: $('fsName'), fsMeta: $('fsMeta'),
        addMore: $('addMore'), clearAll: $('clearAll'),
        cardPages: $('cardPages'), pagesStrip: $('pagesStrip'), pagesCount: $('pagesCount'), sync: $('syncToggle'), removePage: $('removePage'),
        tplList: $('tplList'), alignGrid: $('alignGrid'),
        centerBtn: $('centerBtn'), resetBtn: $('resetBtn'),
        download: $('downloadBtn'), downloadLabel: $('downloadLabel'), downloadAll: $('downloadAllBtn'), share: $('shareBtn'), exportNote: $('exportNote'),
        tgSettings: $('tgSettings'), tgSendOne: $('tgSendOne'), tgSendAll: $('tgSendAll'), tgSendOneLabel: $('tgSendOneLabel'), tgSendAllLabel: $('tgSendAllLabel'), tgStatus: $('tgStatus'),
        tgDialog: $('tgDialog'), tgForm: $('tgForm'), tgToken: $('tgToken'), tgChat: $('tgChat'), tgRemember: $('tgRemember'), tgResult: $('tgResult'),
        tgTest: $('tgTest'), tgCancel: $('tgCancel'), tgForget: $('tgForget'),
    };
    const ctx = el.canvas.getContext('2d');

    /* ═════════════ الحالة ═════════════ */
    const S = {
        templates: [],        // { id, name, file, thumb, w, h, win:{x,y,w,h}, img, thumbImg, thumbCanvas, btn }
        tpl: null,            // القالب الحالي (بعد تحميله)
        pages: [],            // { name, outName, src, w, h, ready, view:{z,dx,dy,rot}, mini, box }
        files: [],            // { name, pages }
        cur: 0,
        sync: true,           // تطبيق التعديلات على كل الصفحات
        mode: 'fit',          // آخر محاذاة تلقائية مطبّقة (null = تعديل يدوي)
        loading: false,       // ما زالت صفحات PDF تُقرأ
        progress: null,       // { done, total }
        busyCount: 0,
        loadToken: 0,
        tplToken: 0,
        interacting: false,
        appendNext: false,
    };

    const clamp = (v, a, b) => Math.min(b, Math.max(a, v));
    const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
    const ltr = (t) => '\u2066' + t + '\u2069';          // يعزل نصاً لاتينياً داخل جملة عربية فلا ينعكس ترتيبه
    const curPage = () => S.pages[S.cur] || null;
    const readyPage = () => { const p = curPage(); return p && p.ready ? p : null; };
    const targets = () => (S.sync ? S.pages.filter((p) => p.ready) : [readyPage()].filter(Boolean));
    const lsGet = (k) => { try { return localStorage.getItem(k); } catch { return null; } };
    const lsSet = (k, v) => { try { localStorage.setItem(k, v); } catch { /* التخزين غير متاح */ } };

    /* ═════════════ واجهة: توست وانشغال ═════════════ */
    let toastTimer;
    function toast(msg, ms = 3600) {
        el.toast.textContent = msg;
        el.toast.classList.add('show');
        clearTimeout(toastTimer);
        toastTimer = setTimeout(() => el.toast.classList.remove('show'), ms);
    }

    function setBusy(on, text) {
        S.busyCount = Math.max(0, S.busyCount + (on ? 1 : -1));
        if (on && text) el.busyText.textContent = text;
        el.busy.hidden = S.busyCount === 0;
    }

    const plural = (n, one, two, few, many) => (n === 1 ? one : n === 2 ? two : n <= 10 ? `${n} ${few}` : `${n} ${many}`);
    const pagesLabel = (n) => plural(n, 'صفحة واحدة', 'صفحتان', 'صفحات', 'صفحة');
    const filesLabel = (n) => plural(n, 'ملف واحد', 'ملفان', 'ملفات', 'ملفاً');

    /* ═════════════ تحميل الصور والقوالب ═════════════ */
    function loadImage(src) {
        return new Promise((resolve, reject) => {
            const img = new Image();
            img.decoding = 'async';
            img.onload = () => resolve(img);
            img.onerror = () => reject(new Error('تعذّر تحميل ' + src));
            img.src = src;
        });
    }

    /* إن لم تُذكر نافذة القالب في templates.js تُكتشف من الشفافية: أكبر مستطيل شفاف في الـPNG */
    function detectWindow(img) {
        const w = img.naturalWidth, h = img.naturalHeight;
        try {
            const c = document.createElement('canvas');
            c.width = w; c.height = h;
            const x = c.getContext('2d', { willReadFrequently: true });
            x.drawImage(img, 0, 0);
            const d = x.getImageData(0, 0, w, h).data;
            let x0 = w, y0 = h, x1 = -1, y1 = -1;
            for (let y = 0; y < h; y++) {
                const row = y * w * 4;
                for (let xx = 0; xx < w; xx++) {
                    if (d[row + xx * 4 + 3] < 8) {
                        if (xx < x0) x0 = xx;
                        if (xx > x1) x1 = xx;
                        if (y < y0) y0 = y;
                        if (y > y1) y1 = y;
                    }
                }
            }
            if (x1 >= 0) return { x: x0, y: y0, w: x1 - x0 + 1, h: y1 - y0 + 1 };
        } catch (e) {
            console.warn('تعذّر اكتشاف نافذة القالب تلقائياً (شغّل الموقع عبر خادم أو استضافة):', e);
        }
        return { x: w * 0.1, y: h * 0.1, w: w * 0.8, h: h * 0.8 };
    }

    async function ensureTemplate(t) {
        if (!t.img) {
            t.img = await loadImage(t.file);
            t.w = t.img.naturalWidth;
            t.h = t.img.naturalHeight;
        }
        if (!t.win) t.win = detectWindow(t.img);
        return t;
    }

    /* ═════════════ هندسة العرض ═════════════
       view = { z, dx, dy, rot }
       z   : التكبير نسبةً إلى ملاءمة الصفحة (بدون تدوير) داخل النافذة
       dx,dy: إزاحة مركز الصفحة عن مركز النافذة (بكسلات القالب)
       rot : التدوير بالدرجات حول مركز الصفحة                                           */
    const baseScale = (p, W) => Math.min(W.w / p.w, W.h / p.h);

    function rotDims(w, h, deg) {
        const r = (deg * Math.PI) / 180, c = Math.abs(Math.cos(r)), s = Math.abs(Math.sin(r));
        return { w: w * c + h * s, h: w * s + h * c };
    }

    /* مستطيل المحتوى (بدون هوامش بيضاء) بإحداثيات الصفحة الأصلية */
    function contentBox(p) {
        if (p.box) return p.box;
        const full = { x: 0, y: 0, w: p.w, h: p.h };
        try {
            const sc = Math.min(1, 520 / Math.max(p.w, p.h));
            const w = Math.max(16, Math.round(p.w * sc)), h = Math.max(16, Math.round(p.h * sc));
            const c = document.createElement('canvas');
            c.width = w; c.height = h;
            const x = c.getContext('2d', { willReadFrequently: true });
            x.fillStyle = '#fff';
            x.fillRect(0, 0, w, h);
            x.drawImage(p.src, 0, 0, w, h);
            const d = x.getImageData(0, 0, w, h).data;
            const lum = new Uint8Array(w * h);
            for (let i = 0, j = 0; i < lum.length; i++, j += 4) lum[i] = (d[j] * 77 + d[j + 1] * 150 + d[j + 2] * 29) >> 8;

            // لون الخلفية = وسيط بكسلات الإطار الخارجي
            const ring = [], b = Math.max(2, Math.round(Math.min(w, h) * 0.01));
            for (let y = 0; y < h; y++) for (let xx = 0; xx < w; xx++) if (y < b || y >= h - b || xx < b || xx >= w - b) ring.push(lum[y * w + xx]);
            ring.sort((a, c2) => a - c2);
            const bg = ring[ring.length >> 1];

            const skip = Math.max(2, Math.round(Math.min(w, h) * 0.012));   // تجاهل حافة الصفحة (ظلال الماسح)
            const cols = new Uint16Array(w), rows = new Uint16Array(h);
            for (let y = skip; y < h - skip; y++) {
                for (let xx = skip; xx < w - skip; xx++) {
                    if (Math.abs(lum[y * w + xx] - bg) > 34) { cols[xx]++; rows[y]++; }
                }
            }
            let x0 = -1, x1 = -1, y0 = -1, y1 = -1;
            for (let xx = 0; xx < w; xx++) if (cols[xx] >= 3) { if (x0 < 0) x0 = xx; x1 = xx; }
            for (let y = 0; y < h; y++) if (rows[y] >= 3) { if (y0 < 0) y0 = y; y1 = y; }
            if (x0 < 0 || y0 < 0) return (p.box = full);

            // خلفية بيضاء: نترك هامشاً صغيراً حول المحتوى. خلفية ملوّنة (صورة ملتقطة): نقصّ عند حافة الورقة تقريباً
            const pad = Math.round(Math.max(w, h) * (bg < 215 ? 0.004 : 0.025));
            x0 = Math.max(0, x0 - pad); y0 = Math.max(0, y0 - pad);
            x1 = Math.min(w - 1, x1 + pad); y1 = Math.min(h - 1, y1 + pad);
            const box = { x: x0 / sc, y: y0 / sc, w: (x1 - x0 + 1) / sc, h: (y1 - y0 + 1) / sc };
            const area = (box.w * box.h) / (p.w * p.h);
            return (p.box = area > 0.97 || area < 0.06 ? full : box);
        } catch (e) {
            return (p.box = full);
        }
    }

    /* المحاذاة التلقائية: تعيد view جديداً للصفحة داخل النافذة W */
    function computePreset(p, mode, W, rot) {
        const rect = mode === 'trim' ? contentBox(p) : { x: 0, y: 0, w: p.w, h: p.h };
        const rd = rotDims(rect.w, rect.h, rot);
        const s = mode === 'fill' ? Math.max(W.w / rd.w, W.h / rd.h)
            : mode === 'width' ? W.w / rd.w
                : Math.min(W.w / rd.w, W.h / rd.h);
        const r = (rot * Math.PI) / 180, c = Math.cos(r), sn = Math.sin(r);
        const ox = rect.x + rect.w / 2 - p.w / 2, oy = rect.y + rect.h / 2 - p.h / 2;   // مركز المستطيل عن مركز الصفحة
        let dx = -s * (ox * c - oy * sn);
        let dy = -s * (ox * sn + oy * c);
        if (mode === 'width' && rd.h * s > W.h) dy += (rd.h * s - W.h) / 2;             // نبدأ من أعلى الصفحة
        const z = clamp(s / baseScale(p, W), ZMIN, ZMAX);
        return clampView(p, { z, dx, dy, rot }, W);
    }

    /* لا نسمح بإخراج الصفحة كلياً من النافذة */
    function clampView(p, v, W) {
        const s = baseScale(p, W) * v.z;
        const rd = rotDims(p.w * s, p.h * s, v.rot);
        const keep = Math.min(80, W.w * 0.15, W.h * 0.15);
        const mx = Math.max(0, (W.w + rd.w) / 2 - keep), my = Math.max(0, (W.h + rd.h) / 2 - keep);
        v.dx = clamp(v.dx, -mx, mx);
        v.dy = clamp(v.dy, -my, my);
        return v;
    }

    /* view صفحة معيّنة داخل قالب آخر (للصور المصغّرة الحيّة) */
    function viewFor(p, t) {
        if (t === S.tpl) return p.view;
        if (S.mode) return computePreset(p, S.mode, t.win, p.view.rot);
        const a = S.tpl.win, b = t.win;
        return clampView(p, { ...p.view, dx: (p.view.dx * b.w) / a.w, dy: (p.view.dy * b.h) / a.h }, b);
    }

    /* ═════════════ الرسم ═════════════ */
    function drawDesign(g, t, overlay, page, view, k) {
        g.setTransform(k, 0, 0, k, 0, 0);
        g.fillStyle = '#fff';
        g.fillRect(0, 0, t.w, t.h);
        if (page && page.ready && view && t.win) {
            const W = t.win;
            const s = baseScale(page, W) * view.z;
            g.save();
            g.beginPath();
            g.rect(W.x - 1, W.y - 1, W.w + 2, W.h + 2);
            g.clip();
            g.translate(W.x + W.w / 2 + view.dx, W.y + W.h / 2 + view.dy);
            g.rotate((view.rot * Math.PI) / 180);
            g.scale(s, s);
            g.drawImage(page.src, -page.w / 2, -page.h / 2);
            g.restore();
        }
        if (overlay) g.drawImage(overlay, 0, 0, t.w, t.h);
    }

    let rafId = 0;
    function scheduleDraw() {
        if (rafId) return;
        rafId = requestAnimationFrame(() => {
            rafId = 0;
            if (!S.tpl) return;
            ctx.imageSmoothingEnabled = true;
            ctx.imageSmoothingQuality = S.interacting ? 'medium' : 'high';
            const p = readyPage();
            drawDesign(ctx, S.tpl, S.tpl.img, p, p && p.view, 1);
        });
    }

    let idleTimer;
    function markInteracting() {
        S.interacting = true;
        clearTimeout(idleTimer);
        idleTimer = setTimeout(() => { S.interacting = false; scheduleDraw(); scheduleThumbs(); }, 160);
    }

    /* ═════════════ الصور المصغّرة الحيّة للقوالب ═════════════ */
    let thumbTimer;
    function scheduleThumbs() {
        clearTimeout(thumbTimer);
        thumbTimer = setTimeout(drawAllThumbs, 120);
    }
    function drawAllThumbs() {
        const p = readyPage();
        for (const t of S.templates) {
            const c = t.thumbCanvas;
            const overlay = t.thumbImg || t.img;
            if (!c || !overlay) continue;
            const x = c.getContext('2d');
            x.imageSmoothingQuality = 'high';
            const usePage = p && t.win;
            drawDesign(x, t, overlay, usePage ? p : null, usePage ? viewFor(p, t) : null, c.width / t.w);
        }
    }

    function buildTemplateList() {
        el.tplList.textContent = '';
        for (const t of S.templates) {
            const b = document.createElement('button');
            b.type = 'button';
            b.className = 'tpl';
            b.setAttribute('role', 'radio');
            b.setAttribute('aria-checked', 'false');
            b.dataset.id = t.id;
            const box = document.createElement('span');
            box.className = 'tpl-box';
            const c = document.createElement('canvas');
            c.width = 176;
            c.height = Math.round((176 * t.h) / t.w);
            t.thumbCanvas = c;
            box.appendChild(c);
            const name = document.createElement('span');
            name.className = 'tpl-name';
            name.textContent = t.name;
            b.append(box, name);
            b.addEventListener('click', () => selectTemplate(t.id));
            t.btn = b;
            el.tplList.appendChild(b);
        }
    }

    async function loadThumbs() {
        await Promise.all(S.templates.map(async (t) => {
            try {
                t.thumbImg = await loadImage(t.thumb || t.file);
            } catch (e) { /* يبقى القالب بدون صورة مصغّرة */ }
        }));
        drawAllThumbs();
    }

    /* ═════════════ اختيار القالب ═════════════ */
    async function selectTemplate(id) {
        const t = S.templates.find((x) => x.id === id);
        if (!t) return;
        const token = ++S.tplToken;
        const needsLoad = !t.img;
        if (needsLoad) setBusy(true, 'جارٍ تحميل القالب…');
        try {
            await ensureTemplate(t);
        } catch (e) {
            toast('تعذّر تحميل القالب. تحقق من الاتصال ثم أعد المحاولة.');
            return;
        } finally {
            if (needsLoad) setBusy(false);
        }
        if (token !== S.tplToken) return;

        const prev = S.tpl;
        S.tpl = t;
        lsSet(LS_TEMPLATE, t.id);
        if (el.canvas.width !== t.w || el.canvas.height !== t.h) {
            el.canvas.width = t.w;
            el.canvas.height = t.h;
        }
        // ملاءمة الصفحات للنافذة الجديدة
        if (prev && prev !== t) {
            for (const p of S.pages) {
                if (!p.ready) continue;
                p.view = S.mode ? computePreset(p, S.mode, t.win, p.view.rot) : viewFor(p, t);
            }
        }
        positionCta();
        for (const x of S.templates) x.btn.setAttribute('aria-checked', String(x === t));
        scheduleDraw();
        scheduleThumbs();
        updateUI();
    }

    function positionCta() {
        const t = S.tpl;
        if (!t) return;
        const W = t.win, s = el.cta.style;
        s.left = (W.x / t.w) * 100 + '%';
        s.top = (W.y / t.h) * 100 + '%';
        s.width = (W.w / t.w) * 100 + '%';
        s.height = (W.h / t.h) * 100 + '%';
    }

    /* ═════════════ قراءة الملفات ═════════════ */
    let pdfPromise;
    function ensurePdfJs() {
        if (window.pdfjsLib) return Promise.resolve(window.pdfjsLib);
        if (!pdfPromise) {
            pdfPromise = new Promise((resolve, reject) => {
                const s = document.createElement('script');
                s.src = PDFJS_SRC;
                s.async = true;
                s.onload = () => { window.pdfjsLib.GlobalWorkerOptions.workerSrc = PDFJS_WORKER; resolve(window.pdfjsLib); };
                s.onerror = () => { pdfPromise = null; reject(new Error('pdfjs')); };
                document.head.appendChild(s);
            });
        }
        return pdfPromise;
    }

    const baseName = (n) => n.replace(/\.[^.]+$/, '').replace(/[\\/:*?"<>|]+/g, '-').trim() || 'قرار';
    const isPdf = (f) => f.type === 'application/pdf' || /\.pdf$/i.test(f.name);
    const isImage = (f) => f.type.startsWith('image/');

    function makeMini(p) {
        const c = p.mini || (p.mini = document.createElement('canvas'));
        c.width = 148; c.height = 200;
        const x = c.getContext('2d');
        x.fillStyle = '#fff';
        x.fillRect(0, 0, 148, 200);
        if (!p.src) return;
        const s = Math.min(148 / p.w, 200 / p.h);
        x.imageSmoothingQuality = 'high';
        x.drawImage(p.src, (148 - p.w * s) / 2, (200 - p.h * s) / 2, p.w * s, p.h * s);
    }

    function addPage(doc, index, total, canvas) {
        const p = {
            name: doc.base,
            outName: total > 1 ? `${doc.base}-${String(index).padStart(Math.max(2, String(total).length), '0')}` : doc.base,
            src: canvas, w: canvas.width, h: canvas.height, ready: true,
            view: null, mini: null, box: null,
        };
        p.view = computePreset(p, S.mode || 'fit', S.tpl.win, 0);
        makeMini(p);
        return p;
    }

    async function readImageFile(file, token, release) {
        const url = URL.createObjectURL(file);
        try {
            const img = await loadImage(url);
            if (token !== S.loadToken) return;
            const iw = img.naturalWidth, ih = img.naturalHeight;
            const k = Math.min(1, Math.sqrt(IMAGE_PX_MAX / (iw * ih)));
            const c = document.createElement('canvas');
            c.width = Math.max(1, Math.round(iw * k));
            c.height = Math.max(1, Math.round(ih * k));
            const x = c.getContext('2d');
            x.fillStyle = '#fff';
            x.fillRect(0, 0, c.width, c.height);
            x.imageSmoothingQuality = 'high';
            x.drawImage(img, 0, 0, c.width, c.height);
            S.pages.push(addPage({ base: baseName(file.name) }, 1, 1, c));
            S.files.push({ name: file.name });
            afterPagesChanged();
            release();
        } catch (e) {
            toast(`تعذّر قراءة الصورة «${file.name}». الصيغة غير مدعومة في هذا المتصفح.`);
        } finally {
            URL.revokeObjectURL(url);
        }
    }

    async function readPdfFile(file, token, release) {
        let pdfjs;
        try {
            pdfjs = await ensurePdfJs();
        } catch (e) {
            toast('تعذّر تحميل قارئ PDF. تحقق من اتصال الإنترنت ثم أعد المحاولة.');
            return;
        }
        let pdf;
        try {
            pdf = await pdfjs.getDocument({ data: await file.arrayBuffer() }).promise;
        } catch (e) {
            toast(e && e.name === 'PasswordException' ? `الملف «${file.name}» محمي بكلمة مرور.` : `تعذّر قراءة الملف «${file.name}». قد يكون تالفاً.`);
            return;
        }
        if (token !== S.loadToken) return;

        const room = MAX_PAGES - S.pages.length;
        const count = Math.min(pdf.numPages, room);
        if (count <= 0) { toast(`الحد الأقصى ${MAX_PAGES} صفحة.`); return; }
        if (pdf.numPages > count) toast(`تم أخذ أول ${count} صفحة فقط (الحد الأقصى ${MAX_PAGES}).`);

        const doc = { base: baseName(file.name) };
        const perPage = clamp(PIXEL_BUDGET / Math.max(count + S.pages.length, 1), PAGE_PX_MIN, PAGE_PX_MAX);
        let registered = false;
        S.loading = true;
        S.progress = { done: 0, total: count };

        try {
            for (let i = 1; i <= count; i++) {
                if (token !== S.loadToken) return;
                const page = await pdf.getPage(i);
                const vp1 = page.getViewport({ scale: 1 });
                const scale = Math.min(3.5, Math.sqrt(perPage / (vp1.width * vp1.height)));
                const vp = page.getViewport({ scale });
                const c = document.createElement('canvas');
                c.width = Math.ceil(vp.width);
                c.height = Math.ceil(vp.height);
                await page.render({ canvasContext: c.getContext('2d'), viewport: vp, background: '#ffffff' }).promise;
                page.cleanup();
                if (token !== S.loadToken) return;

                S.pages.push(addPage(doc, i, count, c));
                if (!registered) { registered = true; S.files.push({ name: file.name }); }
                S.progress.done = i;
                afterPagesChanged();
                release();                            // أول صفحة جاهزة: نزيل شاشة الانتظار ونكمل الباقي في الخلفية
                await new Promise((r) => setTimeout(r));   // نتيح للواجهة التنفّس بين الصفحات
            }
        } catch (e) {
            console.error(e);
            toast('حدث خطأ أثناء قراءة صفحات الملف.');
        } finally {
            pdf.destroy();
            if (token === S.loadToken) { S.loading = false; S.progress = null; updateUI(); }
        }
    }

    async function addFiles(fileList, { append = false } = {}) {
        const files = [...fileList].filter((f) => isPdf(f) || isImage(f));
        if (!files.length) { toast('صيغة الملف غير مدعومة. اختر ملف PDF أو صورة.'); return; }
        if (!S.tpl) { toast('القالب لم يُحمَّل بعد، حاول بعد لحظات.'); return; }

        // نحتفظ بالمستند الحالي لنستعيده إن فشلت قراءة الملف الجديد
        const previous = append ? null : { pages: S.pages, files: S.files, cur: S.cur, mode: S.mode };
        if (!append) resetDocument();
        const token = S.loadToken;
        setBusy(true, 'جارٍ قراءة الملف…');
        let held = true;
        // تُستدعى بعد أول صفحة جاهزة (أو عند الانتهاء/الفشل) لإزالة شاشة الانتظار مرة واحدة فقط
        const release = () => {
            if (!held) return;
            held = false;
            if (token === S.loadToken) setBusy(false);
        };
        try {
            for (const f of files) {
                if (token !== S.loadToken) return;
                if (S.pages.length >= MAX_PAGES) { toast(`الحد الأقصى ${MAX_PAGES} صفحة.`); break; }
                await (isPdf(f) ? readPdfFile(f, token, release) : readImageFile(f, token, release));
            }
        } finally {
            release();
            if (previous && token === S.loadToken && S.pages.length === 0) {
                Object.assign(S, previous);
                buildStrip();
                updateUI();
                scheduleDraw();
                scheduleThumbs();
            }
        }
    }

    function resetDocument() {
        S.loadToken++;
        S.pages = [];
        S.files = [];
        S.cur = 0;
        S.mode = 'fit';
        S.loading = false;
        S.progress = null;
        S.busyCount = 0;
        el.busy.hidden = true;
    }

    function afterPagesChanged() {
        if (S.cur >= S.pages.length) S.cur = S.pages.length - 1;
        if (S.pages.length === 1) maybeShowTip();
        buildStrip();
        updateUI();
        scheduleDraw();
        scheduleThumbs();
    }

    /* تلميح القرص بإصبعين: مرة واحدة فقط وعلى أجهزة اللمس */
    function maybeShowTip() {
        if (!window.matchMedia('(pointer: coarse)').matches || lsGet(LS_TIP)) return;
        lsSet(LS_TIP, '1');
        el.tip.hidden = false;
        el.tip.addEventListener('animationend', () => { el.tip.hidden = true; }, { once: true });
    }

    /* ═════════════ الصفحات ═════════════ */
    function buildStrip() {
        el.pagesStrip.textContent = '';
        S.pages.forEach((p, i) => {
            const b = document.createElement('button');
            b.type = 'button';
            b.className = 'pg';
            b.setAttribute('role', 'option');
            b.setAttribute('aria-label', `الصفحة ${i + 1}`);
            b.setAttribute('aria-selected', String(i === S.cur));
            b.appendChild(p.mini);
            const n = document.createElement('span');
            n.className = 'pg-n';
            n.textContent = String(i + 1);
            b.appendChild(n);
            b.addEventListener('click', () => goPage(i));
            el.pagesStrip.appendChild(b);
        });
    }

    function goPage(i) {
        if (i < 0 || i >= S.pages.length) return;
        S.cur = i;
        for (const [k, b] of [...el.pagesStrip.children].entries()) b.setAttribute('aria-selected', String(k === i));
        const active = el.pagesStrip.children[i];
        if (active) {
            const a = active.getBoundingClientRect(), b = el.pagesStrip.getBoundingClientRect();
            el.pagesStrip.scrollBy({ left: a.left + a.width / 2 - (b.left + b.width / 2), behavior: 'smooth' });
        }
        updateUI();
        scheduleDraw();
        scheduleThumbs();
    }

    function removeCurrentPage() {
        if (!S.pages.length) return;
        S.pages.splice(S.cur, 1);
        if (!S.pages.length) { clearAll(); return; }
        S.cur = Math.min(S.cur, S.pages.length - 1);
        buildStrip();
        updateUI();
        scheduleDraw();
        scheduleThumbs();
    }

    function clearAll() {
        resetDocument();
        buildStrip();
        updateUI();
        scheduleDraw();
        scheduleThumbs();
    }

    /* ═════════════ عمليات العرض (تُطبَّق على الصفحة الحالية أو كل الصفحات) ═════════════ */
    const winCenter = () => ({ x: S.tpl.win.x + S.tpl.win.w / 2, y: S.tpl.win.y + S.tpl.win.h / 2 });

    function afterViewChange() {
        S.mode = null;
        markInteracting();
        scheduleDraw();
        syncQuick();
        syncAlign();
    }

    function opPan(dx, dy) {
        if (!S.tpl) return;
        for (const p of targets()) {
            p.view.dx += dx;
            p.view.dy += dy;
            clampView(p, p.view, S.tpl.win);
        }
        afterViewChange();
    }

    /* تكبير بمعامل k حول النقطة pivot (بإحداثيات القالب) */
    function opZoom(k, pivot) {
        if (!S.tpl) return;
        const wc = winCenter();
        for (const p of targets()) {
            const v = p.view;
            const nz = clamp(v.z * k, ZMIN, ZMAX);
            const kk = nz / v.z;
            v.dx = (wc.x + v.dx - pivot.x) * kk + pivot.x - wc.x;
            v.dy = (wc.y + v.dy - pivot.y) * kk + pivot.y - wc.y;
            v.z = nz;
            clampView(p, v, S.tpl.win);
        }
        afterViewChange();
    }

    /* تدوير بمقدار delta درجة حول مركز النافذة */
    function opRotate(delta) {
        if (!S.tpl) return;
        const r = (delta * Math.PI) / 180, c = Math.cos(r), s = Math.sin(r);
        for (const p of targets()) {
            const v = p.view;
            const dx = v.dx * c - v.dy * s, dy = v.dx * s + v.dy * c;
            v.dx = dx; v.dy = dy;
            v.rot += delta;
            clampView(p, v, S.tpl.win);
        }
        afterViewChange();
    }

    function applyPreset(mode) {
        if (!S.tpl) return;
        for (const p of targets()) p.view = computePreset(p, mode, S.tpl.win, p.view.rot);
        S.mode = mode;
        markInteracting();
        scheduleDraw();
        scheduleThumbs();
        syncQuick();
        syncAlign();
    }

    function rotate90(dir) {
        const keep = S.mode;
        opRotate(dir * 90);
        if (keep) applyPreset(keep);          // بعد التدوير نعيد ملاءمة الصفحة تلقائياً
    }

    function centerView() {
        for (const p of targets()) { p.view.dx = 0; p.view.dy = 0; }
        afterViewChange();
    }

    function resetView() {
        for (const p of targets()) p.view.rot = 0;
        applyPreset('fit');
    }

    /* ═════════════ الشرائح وتحديث الواجهة ═════════════ */
    const zToSlider = (z) => Math.round((Math.log(z / ZMIN) / Math.log(ZMAX / ZMIN)) * 1000);
    const sliderToZ = (v) => ZMIN * Math.pow(ZMAX / ZMIN, v / 1000);
    const setPct = (input) => input.style.setProperty('--pct', ((input.value - input.min) / (input.max - input.min)) * 100 + '%');
    const normDeg = (d) => ((((d % 360) + 540) % 360) - 180);

    let skipSync = null;          // الشريط الذي يسحبه المستخدم الآن (لا نغيّر قيمته برمجياً أثناء السحب)
    function syncQuick(skip = skipSync) {
        const p = readyPage();
        if (!p) {
            el.zoomSlider.value = 500;
            el.zoomValue.textContent = '100%';
            el.rotSlider.value = 0;
            el.rotValue.textContent = '0°';
        } else {
            if (skip !== el.zoomSlider) el.zoomSlider.value = zToSlider(p.view.z);
            el.zoomValue.textContent = Math.round(p.view.z * 100) + '%';
            const fine = p.view.rot - 90 * Math.round(p.view.rot / 90);
            if (skip !== el.rotSlider) el.rotSlider.value = fine;
            const shown = Math.round(normDeg(p.view.rot) * 10) / 10;
            el.rotValue.textContent = shown + '°';
        }
        setPct(el.zoomSlider);
        setPct(el.rotSlider);
    }

    function syncAlign() {
        for (const b of el.alignGrid.children) b.setAttribute('aria-pressed', String(b.dataset.mode === S.mode));
    }

    function updateUI() {
        const has = S.pages.length > 0;
        const p = readyPage();
        el.stage.dataset.empty = String(!p);
        el.panel.dataset.empty = String(!has);
        el.cta.hidden = has;
        el.summary.hidden = !has;

        // الملف
        if (has) {
            const totalPages = S.pages.length;
            el.fsName.textContent = S.files.length === 1 ? S.files[0].name : filesLabel(S.files.length);
            el.fsMeta.textContent = S.progress && S.loading
                ? `جارٍ التجهيز ${S.progress.done}/${S.progress.total}…`
                : pagesLabel(totalPages);
        }

        // الصفحات
        const multi = S.pages.length > 1;
        el.cardPages.hidden = !multi;
        el.pager.hidden = !multi;
        if (multi) {
            el.pagesCount.textContent = pagesLabel(S.pages.length);
            el.pagerText.textContent = `${S.cur + 1} / ${S.pages.length}`;
            el.prev.disabled = S.cur === 0;
            el.next.disabled = S.cur === S.pages.length - 1;
        }

        // أدوات الضبط
        const off = !p;
        for (const c of [el.zoomSlider, el.zoomIn, el.zoomOut, el.rotSlider, el.rotLeft, el.rotRight, el.centerBtn, el.resetBtn, el.download]) c.disabled = off;
        for (const b of el.alignGrid.children) b.disabled = off;
        el.downloadAll.hidden = !multi;
        el.downloadAll.disabled = off || S.loading;
        el.share.hidden = !canShareFiles || !has;
        el.share.disabled = off || S.loading;
        el.downloadLabel.textContent = multi ? 'تحميل هذه الصفحة' : 'تحميل الصورة';
        el.tgSendOne.disabled = off;
        el.tgSendAll.hidden = !multi;
        el.tgSendAll.disabled = off || S.loading;
        el.tgSendOneLabel.textContent = multi ? 'هذه الصفحة' : 'إرسال الصورة';
        el.tgSendAllLabel.textContent = `كل الصفحات (${S.pages.length})`;
        if (S.tpl) el.exportNote.textContent = `صورة PNG بحجم ${S.tpl.w}×${S.tpl.h} بكسل`;

        syncQuick();
        syncAlign();
    }

    /* ═════════════ التصدير ═════════════ */
    async function renderBlob(p) {
        const c = document.createElement('canvas');
        c.width = S.tpl.w;
        c.height = S.tpl.h;
        const g = c.getContext('2d');
        g.imageSmoothingQuality = 'high';
        drawDesign(g, S.tpl, S.tpl.img, p, p.view, 1);
        return new Promise((resolve, reject) => c.toBlob((b) => (b ? resolve(b) : reject(new Error('toBlob'))), 'image/png'));
    }

    function saveBlob(blob, name) {
        const url = URL.createObjectURL(blob);
        const a = document.createElement('a');
        a.href = url;
        a.download = name;
        document.body.appendChild(a);
        a.click();
        a.remove();
        setTimeout(() => URL.revokeObjectURL(url), 5000);
    }

    function uniqueNames(pages) {
        const seen = new Map();
        return pages.map((p) => {
            const n = seen.get(p.outName) || 0;
            seen.set(p.outName, n + 1);
            return n ? `${p.outName} (${n + 1}).png` : `${p.outName}.png`;
        });
    }

    async function withExportBusy(text, fn) {
        setBusy(true, text);
        try {
            await fn();
        } catch (e) {
            console.error(e);
            toast(e && e.name === 'SecurityError'
                ? 'تعذّر التصدير: شغّل الموقع عبر خادم أو استضافة (وليس فتح الملف مباشرة).'
                : 'تعذّر إنشاء الصورة. حاول مرة أخرى.');
        } finally {
            setBusy(false);
        }
    }

    function downloadCurrent() {
        const p = readyPage();
        if (!p) return toast('ارفع ملفاً أولاً.');
        withExportBusy('جارٍ تجهيز الصورة…', async () => saveBlob(await renderBlob(p), uniqueNames([p])[0]));
    }

    function downloadAll() {
        if (!S.pages.length || S.loading) return;
        withExportBusy('جارٍ تجهيز الصفحات…', async () => {
            const names = uniqueNames(S.pages);
            const files = [];
            for (let i = 0; i < S.pages.length; i++) {
                el.busyText.textContent = `جارٍ تجهيز الصفحات ${i + 1} / ${S.pages.length}…`;
                const blob = await renderBlob(S.pages[i]);
                files.push({ name: names[i], data: new Uint8Array(await blob.arrayBuffer()) });
                await new Promise((r) => setTimeout(r));
            }
            const base = S.files.length === 1 ? baseName(S.files[0].name) : 'القرارات';
            saveBlob(window.zipStore(files), `${base}.zip`);
        });
    }

    const canShareFiles = (() => {
        try {
            return !!(navigator.canShare && navigator.canShare({ files: [new File([new Blob(['x'])], 'a.png', { type: 'image/png' })] }));
        } catch { return false; }
    })();

    function shareAll() {
        if (!S.pages.length || S.loading) return;
        withExportBusy('جارٍ تجهيز الصور للمشاركة…', async () => {
            const names = uniqueNames(S.pages);
            const files = [];
            for (let i = 0; i < S.pages.length; i++) files.push(new File([await renderBlob(S.pages[i])], names[i], { type: 'image/png' }));
            setBusy(false);
            try {
                await navigator.share({ files, title: 'قرار' });
            } catch (e) {
                if (e && e.name !== 'AbortError') toast('تعذّرت المشاركة. استخدم زر التحميل بدلاً منها.');
            } finally {
                setBusy(true);          // يوازن setBusy(false) في withExportBusy
            }
        });
    }

    /* ═════════════ الإرسال إلى تلغرام كملف (Bot API) ═════════════
       يُرسَل كل تصميم عبر sendDocument (أو sendMediaGroup لأكثر من صفحة) فيصل مستنداً بلا ضغط.
       رمز البوت ومعرّف القناة يُدخلهما المستخدم ويُحفظان في متصفحه فقط — لا شيء منهما في كود الموقع. */
    const TG_API = 'https://api.telegram.org';
    const TG_TOKEN_RE = /^\d{6,12}:[A-Za-z0-9_-]{30,}$/;
    const tg = { token: '', chat: '', remember: true };
    let tgPending = null;                    // إرسال ينتظر انتهاء الإعداد

    function tgLoad() {
        const d = window.TELEGRAM_DEFAULT;                    // وجهة افتراضية من telegram.config.js
        if (d && d.token && d.chat) { tg.token = String(d.token); tg.chat = String(d.chat); }
        for (const [name, remember] of [['localStorage', true], ['sessionStorage', false]]) {
            try {
                const raw = window[name].getItem(LS_TG);
                if (!raw) continue;
                const o = JSON.parse(raw);
                tg.token = String(o.token || '');
                tg.chat = String(o.chat || '');
                tg.remember = remember;
                return;
            } catch { /* التخزين غير متاح */ }
        }
    }

    function tgPersist() {
        for (const name of ['localStorage', 'sessionStorage']) { try { window[name].removeItem(LS_TG); } catch { /* */ } }
        if (!tg.token) return;
        try { window[tg.remember ? 'localStorage' : 'sessionStorage'].setItem(LS_TG, JSON.stringify({ token: tg.token, chat: tg.chat })); } catch { /* */ }
    }

    const tgConfigured = () => TG_TOKEN_RE.test(tg.token) && !!tg.chat;

    /* @name أو t.me/name أو رقم (قد يكون سالباً للقنوات والمجموعات) */
    function normalizeChat(v) {
        v = String(v).trim();
        if (/^-?\d+$/.test(v)) return v;
        const m = v.match(/(?:t\.me\/|@)([A-Za-z][A-Za-z0-9_]{3,})\/?$/) || v.match(/^([A-Za-z][A-Za-z0-9_]{3,})$/);
        return m ? '@' + m[1] : '';
    }

    class TgError extends Error {
        constructor(message, code = 0, retryAfter = 0) { super(message); this.code = code; this.retryAfter = retryAfter; }
    }

    function tgMessage(code, desc = '') {
        const d = String(desc).toLowerCase();
        if (code === 401 || code === 404) return 'رمز البوت غير صحيح أو أُلغي. انسخه من BotFather مرة أخرى.';
        if (code === 403) return 'البوت لا يملك صلاحية الإرسال هنا. اجعله مشرفاً في القناة (نشر الرسائل)، أو افتح المحادثة معه واضغط Start.';
        if (code === 400 && d.includes('chat not found')) return 'لم يتم العثور على القناة أو المحادثة. تحقق من المعرّف ومن أن البوت مضاف إليها.';
        if (code === 400 && (d.includes('not enough rights') || d.includes('administrator'))) return 'البوت لا يملك صلاحية النشر. اجعله مشرفاً بصلاحية «نشر الرسائل».';
        if (code === 413) return 'حجم الملف أكبر من المسموح في تلغرام.';
        if (code === 429) return 'تلغرام يطلب التمهّل. أعد المحاولة بعد لحظات.';
        return 'تلغرام: ' + (desc || 'خطأ غير معروف');
    }

    async function tgCall(token, method, form) {
        let res;
        try {
            res = await fetch(`${TG_API}/bot${token}/${method}`, { method: 'POST', body: form });
        } catch {
            throw new TgError('تعذّر الاتصال بتلغرام. تحقق من الإنترنت (وقد يكون تلغرام محجوباً على هذه الشبكة).');
        }
        let data = null;
        try { data = await res.json(); } catch { /* ردّ غير JSON */ }
        if (data && data.ok) return data.result;
        const code = (data && data.error_code) || res.status;
        throw new TgError(tgMessage(code, data && data.description), code, (data && data.parameters && data.parameters.retry_after) || 0);
    }

    /* نعيد المحاولة مرة واحدة إذا طلب تلغرام التمهّل (429) */
    async function tgCallRetry(method, build) {
        try {
            return await tgCall(tg.token, method, build());
        } catch (e) {
            if (e.code === 429 && e.retryAfter && e.retryAfter <= 30) {
                await sleep(e.retryAfter * 1000 + 300);
                return tgCall(tg.token, method, build());
            }
            throw e;
        }
    }

    const tgForm = (fields) => { const fd = new FormData(); for (const [k, v] of Object.entries(fields)) fd.append(k, v); return fd; };

    async function tgSend(pages) {
        if (!pages.length) return;
        if (!tgConfigured()) { openTgDialog(() => tgSend(pages)); return; }
        const names = uniqueNames(pages);
        setBusy(true, 'جارٍ تجهيز الملفات…');
        try {
            let sent = 0;
            for (let i = 0; i < pages.length; i += 10) {           // ألبوم تلغرام: حتى 10 ملفات
                const files = [];
                for (let j = i; j < Math.min(i + 10, pages.length); j++) {
                    el.busyText.textContent = `جارٍ تجهيز الصفحة ${j + 1} / ${pages.length}…`;
                    files.push(new File([await renderBlob(pages[j])], names[j], { type: 'image/png' }));
                }
                el.busyText.textContent = pages.length > 1 ? `جارٍ الإرسال إلى تلغرام… ${i + files.length} / ${pages.length}` : 'جارٍ الإرسال إلى تلغرام…';
                if (files.length === 1) {
                    await tgCallRetry('sendDocument', () => {
                        const fd = tgForm({ chat_id: tg.chat, disable_content_type_detection: 'true' });
                        fd.append('document', files[0], files[0].name);
                        return fd;
                    });
                } else {
                    await tgCallRetry('sendMediaGroup', () => {
                        const fd = tgForm({
                            chat_id: tg.chat,
                            media: JSON.stringify(files.map((f, k) => ({ type: 'document', media: `attach://f${k}`, disable_content_type_detection: true }))),
                        });
                        files.forEach((f, k) => fd.append(`f${k}`, f, f.name));
                        return fd;
                    });
                }
                sent += files.length;
                if (i + 10 < pages.length) await sleep(1200);
            }
            toast(`تم إرسال ${sent === 2 ? 'ملفين' : filesLabel(sent)} إلى تلغرام ✓`);
        } catch (e) {
            if (e instanceof TgError) toast(e.message, 6000);
            else { console.error(e); toast('تعذّر الإرسال. حاول مرة أخرى.'); }
        } finally {
            setBusy(false);
        }
    }

    /* فحص الإعداد قبل الحفظ: البوت موجود؟ القناة موجودة؟ البوت مشرف؟ */
    async function tgTestConnection(token, chat) {
        const me = await tgCall(token, 'getMe', new FormData());
        const info = await tgCall(token, 'getChat', tgForm({ chat_id: chat }));
        const title = info.title || [info.first_name, info.last_name].filter(Boolean).join(' ') || chat;
        if (info.type === 'channel' || info.type === 'group' || info.type === 'supergroup') {
            try {
                const m = await tgCall(token, 'getChatMember', tgForm({ chat_id: chat, user_id: me.id }));
                const admin = m.status === 'administrator' || m.status === 'creator';
                if (info.type === 'channel' && !(admin && m.can_post_messages !== false)) {
                    return { ok: false, text: `البوت ${ltr('@' + me.username)} موجود في «${title}» لكنه ليس مشرفاً بصلاحية نشر الرسائل.` };
                }
                if (m.status === 'left' || m.status === 'kicked') {
                    return { ok: false, text: `البوت ${ltr('@' + me.username)} غير مضاف إلى «${title}».` };
                }
            } catch { /* لا نمنع الحفظ إن تعذّر فحص الصلاحيات */ }
        }
        return { ok: true, text: `✓ البوت ${ltr('@' + me.username)} متصل بـ «${title}».` };
    }

    function openTgDialog(after) {
        tgPending = after || null;
        el.tgToken.value = tg.token;
        el.tgChat.value = tg.chat;
        el.tgRemember.checked = tg.remember;
        setTgResult('');
        if (typeof el.tgDialog.showModal === 'function') el.tgDialog.showModal();
        else el.tgDialog.setAttribute('open', '');
        setTimeout(() => (tg.token ? el.tgChat : el.tgToken).focus(), 50);
    }

    function closeTgDialog() {
        if (el.tgDialog.open) el.tgDialog.close();
        el.tgToken.value = '';          // لا نُبقي الرمز في الحقل بعد الإغلاق
    }

    function setTgResult(text, kind = '') {
        el.tgResult.textContent = text;
        el.tgResult.className = 'dlg-result' + (kind ? ' ' + kind : '');
    }

    /* يقرأ الحقول ويتحقق منها؛ يعيد null مع رسالة خطأ إن كانت غير صالحة */
    function readTgFields() {
        const token = el.tgToken.value.trim();
        const chat = normalizeChat(el.tgChat.value);
        if (!TG_TOKEN_RE.test(token)) { setTgResult(`رمز البوت غير صالح. شكله: ${ltr('123456789:AAH…')} (انسخه كاملاً من BotFather).`, 'bad'); el.tgToken.focus(); return null; }
        if (!chat) { setTgResult('اكتب معرّف القناة بصيغة @اسم_القناة، أو رقم المحادثة.', 'bad'); el.tgChat.focus(); return null; }
        el.tgChat.value = chat;
        return { token, chat };
    }

    async function onTgTest() {
        const f = readTgFields();
        if (!f) return;
        el.tgTest.disabled = true;
        setTgResult('جارٍ الفحص…');
        try {
            const r = await tgTestConnection(f.token, f.chat);
            setTgResult(r.text, r.ok ? 'ok' : 'bad');
        } catch (e) {
            setTgResult(e instanceof TgError ? e.message : 'تعذّر الفحص.', 'bad');
        } finally {
            el.tgTest.disabled = false;
        }
    }

    function onTgSave(e) {
        e.preventDefault();
        const f = readTgFields();
        if (!f) return;
        tg.token = f.token;
        tg.chat = f.chat;
        tg.remember = el.tgRemember.checked;
        tgPersist();
        const next = tgPending;
        tgPending = null;
        closeTgDialog();
        updateTgUI();
        if (next) next(); else toast('تم حفظ إعداد تلغرام ✓');
    }

    function onTgForget() {
        tg.token = '';
        tg.chat = '';
        tgPersist();
        el.tgToken.value = '';
        el.tgChat.value = '';
        setTgResult('تم مسح البيانات المحفوظة.', 'ok');
        updateTgUI();
    }

    function updateTgUI() {
        el.tgStatus.textContent = tgConfigured() ? `الوجهة: ${ltr(tg.chat)}` : 'لم يتم الإعداد بعد — اضغط «إعداد» ثم أدخل رمز البوت والقناة.';
    }

    /* ═════════════ التفاعل: سحب + قرص + عجلة + لوحة مفاتيح ═════════════ */
    const pointers = new Map();
    let pinch = null;

    function toDesign(e) {
        const r = el.canvas.getBoundingClientRect();
        return { x: ((e.clientX - r.left) * S.tpl.w) / r.width, y: ((e.clientY - r.top) * S.tpl.h) / r.height };
    }

    el.canvas.addEventListener('pointerdown', (e) => {
        if (!readyPage() || (e.pointerType === 'mouse' && e.button !== 0)) return;
        e.preventDefault();
        try { el.canvas.setPointerCapture(e.pointerId); } catch { /* المؤشر لم يعد نشطاً */ }
        pointers.set(e.pointerId, toDesign(e));
        if (pointers.size === 2) {
            const [a, b] = [...pointers.values()];
            pinch = { dist: Math.hypot(a.x - b.x, a.y - b.y), mid: { x: (a.x + b.x) / 2, y: (a.y + b.y) / 2 } };
        }
        el.canvas.focus({ preventScroll: true });
    });

    el.canvas.addEventListener('pointermove', (e) => {
        if (!pointers.has(e.pointerId) || !readyPage()) return;
        const now = toDesign(e), before = pointers.get(e.pointerId);
        pointers.set(e.pointerId, now);
        if (pointers.size === 1) {
            opPan(now.x - before.x, now.y - before.y);
        } else if (pointers.size === 2 && pinch) {
            const [a, b] = [...pointers.values()];
            const dist = Math.hypot(a.x - b.x, a.y - b.y), mid = { x: (a.x + b.x) / 2, y: (a.y + b.y) / 2 };
            if (pinch.dist > 8 && dist > 8) opZoom(dist / pinch.dist, mid);
            opPan(mid.x - pinch.mid.x, mid.y - pinch.mid.y);
            pinch = { dist, mid };
        }
    });

    function endPointer(e) {
        if (!pointers.delete(e.pointerId)) return;
        pinch = null;
        if (pointers.size === 0) scheduleThumbs();
    }
    el.canvas.addEventListener('pointerup', endPointer);
    el.canvas.addEventListener('pointercancel', endPointer);
    el.canvas.addEventListener('lostpointercapture', endPointer);

    // منع تكبير الصفحة نفسها في سفاري القديم أثناء القرص على المعاينة
    for (const ev of ['gesturestart', 'gesturechange']) el.canvas.addEventListener(ev, (e) => e.preventDefault());

    el.canvas.addEventListener('wheel', (e) => {
        if (!readyPage()) return;
        e.preventDefault();
        const dy = e.deltaMode === 1 ? e.deltaY * 33 : e.deltaY;
        opZoom(Math.exp(-dy * (e.ctrlKey ? 0.01 : 0.0016)), toDesign(e));
    }, { passive: false });

    el.canvas.addEventListener('keydown', (e) => {
        if (!readyPage()) return;
        const step = (e.shiftKey ? 48 : 12);
        const map = { ArrowLeft: [-step, 0], ArrowRight: [step, 0], ArrowUp: [0, -step], ArrowDown: [0, step] };
        if (map[e.key]) { e.preventDefault(); opPan(...map[e.key]); }
        else if (e.key === '+' || e.key === '=') { e.preventDefault(); opZoom(1.1, winCenter()); }
        else if (e.key === '-' || e.key === '_') { e.preventDefault(); opZoom(1 / 1.1, winCenter()); }
        else if (e.key === '0') { e.preventDefault(); applyPreset('fit'); }
        else if (e.key === 'r' || e.key === 'R') { e.preventDefault(); rotate90(e.shiftKey ? -1 : 1); }
    });

    /* ═════════════ ربط عناصر التحكم ═════════════ */
    el.zoomSlider.addEventListener('input', () => {
        const p = readyPage();
        if (!p) return;
        skipSync = el.zoomSlider;
        opZoom(sliderToZ(+el.zoomSlider.value) / p.view.z, winCenter());
        skipSync = null;
    });
    el.zoomSlider.addEventListener('change', scheduleThumbs);
    el.zoomIn.addEventListener('click', () => opZoom(1.12, winCenter()));
    el.zoomOut.addEventListener('click', () => opZoom(1 / 1.12, winCenter()));

    el.rotSlider.addEventListener('input', () => {
        const p = readyPage();
        if (!p) return;
        const base = 90 * Math.round(p.view.rot / 90);
        skipSync = el.rotSlider;
        opRotate(base + parseFloat(el.rotSlider.value) - p.view.rot);
        skipSync = null;
    });
    el.rotSlider.addEventListener('change', scheduleThumbs);
    el.rotLeft.addEventListener('click', () => rotate90(-1));
    el.rotRight.addEventListener('click', () => rotate90(1));

    el.alignGrid.addEventListener('click', (e) => {
        const b = e.target.closest('.tile');
        if (b && !b.disabled) applyPreset(b.dataset.mode);
    });
    el.centerBtn.addEventListener('click', centerView);
    el.resetBtn.addEventListener('click', resetView);

    el.sync.addEventListener('change', () => { S.sync = el.sync.checked; });
    el.prev.addEventListener('click', () => goPage(S.cur - 1));
    el.next.addEventListener('click', () => goPage(S.cur + 1));
    el.removePage.addEventListener('click', removeCurrentPage);

    el.download.addEventListener('click', downloadCurrent);
    el.downloadAll.addEventListener('click', downloadAll);
    el.share.addEventListener('click', shareAll);

    el.tgSettings.addEventListener('click', () => openTgDialog());
    el.tgSendOne.addEventListener('click', () => { const p = readyPage(); if (p) tgSend([p]); });
    el.tgSendAll.addEventListener('click', () => { if (!S.loading) tgSend(S.pages.slice()); });
    el.tgForm.addEventListener('submit', onTgSave);
    el.tgTest.addEventListener('click', onTgTest);
    el.tgCancel.addEventListener('click', () => { tgPending = null; closeTgDialog(); });
    el.tgForget.addEventListener('click', onTgForget);
    el.tgDialog.addEventListener('click', (e) => { if (e.target === el.tgDialog) { tgPending = null; closeTgDialog(); } });   // النقر على الخلفية
    el.tgDialog.addEventListener('close', () => { tgPending = null; el.tgToken.value = ''; });

    /* رفع الملفات */
    el.cta.addEventListener('click', () => { S.appendNext = false; el.fileInput.click(); });
    el.dropzone.addEventListener('click', () => { S.appendNext = false; });
    el.addMore.addEventListener('click', () => { S.appendNext = true; el.fileInput.click(); });
    el.clearAll.addEventListener('click', clearAll);
    el.fileInput.addEventListener('change', () => {
        const files = [...el.fileInput.files];
        el.fileInput.value = '';
        if (files.length) addFiles(files, { append: S.appendNext });
        S.appendNext = false;
    });

    // سحب وإفلات على الصفحة كلها
    const hasFiles = (e) => e.dataTransfer && [...e.dataTransfer.types].includes('Files');
    const setDrag = (on) => { el.frame.classList.toggle('dragover', on); document.body.classList.toggle('dragging', on); };
    for (const ev of ['dragenter', 'dragover']) window.addEventListener(ev, (e) => { if (hasFiles(e)) { e.preventDefault(); setDrag(true); } });
    window.addEventListener('dragleave', (e) => { if (!e.relatedTarget) setDrag(false); });
    window.addEventListener('drop', (e) => {
        if (!hasFiles(e)) return;
        e.preventDefault();
        setDrag(false);
        addFiles(e.dataTransfer.files, { append: false });
    });

    // لصق صورة من الحافظة
    window.addEventListener('paste', (e) => {
        const files = e.clipboardData ? [...e.clipboardData.files].filter(isImage) : [];
        if (files.length) { e.preventDefault(); addFiles(files, { append: false }); }
    });

    /* ═════════════ البدء ═════════════ */
    async function init() {
        S.templates = (window.TEMPLATES || []).map((t) => ({ ...t, win: t.win ? { x: t.win[0], y: t.win[1], w: t.win[2], h: t.win[3] } : null, img: null, thumbImg: null }));
        // قوالب أُضيفت يدوياً بدون w/h/win: نحمّلها الآن لنعرف حجمها ونافذتها
        await Promise.all(S.templates.filter((t) => !t.w || !t.h || !t.win).map((t) => ensureTemplate(t).catch(() => { t.broken = true; })));
        S.templates = S.templates.filter((t) => !t.broken);
        if (!S.templates.length) { toast('لم يتم العثور على أي قالب (templates.js).'); return; }
        buildTemplateList();
        tgLoad();
        updateTgUI();
        updateUI();
        const saved = lsGet(LS_TEMPLATE);
        await selectTemplate((S.templates.find((t) => t.id === saved) || S.templates[0]).id);
        loadThumbs();
        // نجهّز قارئ PDF في الخلفية ليكون جاهزاً عند اختيار الملف
        const idle = window.requestIdleCallback || ((fn) => setTimeout(fn, 1200));
        idle(() => ensurePdfJs().catch(() => { }));
    }

    init();
})();
