const express = require("express");
const { Pool } = require("pg"); 
const bodyParser = require("body-parser");
const cors = require("cors");
const path = require('path');

const app = express();
app.use(cors());
app.use(bodyParser.json());

// --- THE NEON CLOUD VAULT CONNECTION ---
const pool = new Pool({
    connectionString: "postgresql://neondb_owner:npg_VgjU3LqG5Xou@ep-cold-cherry-a1yzxv4e-pooler.ap-southeast-1.aws.neon.tech/neondb?sslmode=require&channel_binding=require"
});

// --- GOOGLE SHEETS LIVE SYNC ENGINE ---
// ⚠️ PASTE YOUR BRAND NEW APPS SCRIPT URL HERE:
const SHEET_WEBHOOK ="https://script.google.com/macros/s/AKfycbyDisr6R5BoY4c1LwRwoAtPzi8BRRKUfqkTU__Y0-ibJsH08aPt3S4uFmlA42GU8lg4FQ/exev";

async function pushToSheets(eventType, operator, payload) {
    try {
        await fetch(SHEET_WEBHOOK, {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify({ event_type: eventType, operator: operator || "System", payload: payload }),
            redirect: "follow" 
        });
    } catch (e) {
        console.log("⚠️ Google Sheet Sync Failed:", e.message);
    }
}

// Initialize Cloud Database Tables
const initDB = async () => {
    try {
        await pool.query(`CREATE TABLE IF NOT EXISTS batches (id SERIAL PRIMARY KEY, batch_code TEXT UNIQUE, fg_code TEXT, status TEXT DEFAULT 'OPEN', created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP, operator_name TEXT)`);
        await pool.query(`CREATE TABLE IF NOT EXISTS scans (id SERIAL PRIMARY KEY, batch_code TEXT, rm_tag TEXT, product_code TEXT, scan_time TIMESTAMP DEFAULT CURRENT_TIMESTAMP)`);
        await pool.query(`CREATE TABLE IF NOT EXISTS ingredients (product_code TEXT PRIMARY KEY, ingredient_name TEXT)`);
        await pool.query(`CREATE TABLE IF NOT EXISTS vendors (vendor_code TEXT PRIMARY KEY, vendor_name TEXT)`);
        await pool.query(`CREATE TABLE IF NOT EXISTS recipes (id SERIAL PRIMARY KEY, fg_code TEXT, product_code TEXT)`);
        await pool.query(`CREATE TABLE IF NOT EXISTS inventory (rm_tag TEXT PRIMARY KEY, product_code TEXT, original_weight REAL, current_weight REAL, last_audited TIMESTAMP DEFAULT CURRENT_TIMESTAMP)`);
        await pool.query(`CREATE TABLE IF NOT EXISTS audit_history (id SERIAL PRIMARY KEY, session_name TEXT, rm_tag TEXT, product_code TEXT, audited_weight REAL, audited_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP)`);
        await pool.query(`CREATE TABLE IF NOT EXISTS inwarding_logs (id SERIAL PRIMARY KEY, date_received TEXT, ingredient_name TEXT, ingredient_code TEXT, vendor_name TEXT, vendor_code TEXT, weight REAL, packs INTEGER, created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP)`);
        await pool.query(`CREATE TABLE IF NOT EXISTS sub_assemblies (id SERIAL PRIMARY KEY, sub_tag TEXT, parent_tag TEXT, process_type TEXT, operator TEXT, created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP)`);
        console.log("✅ Neon Cloud Vault Initialized");
    } catch(e) { console.error("Database Init Error:", e); }
};
initDB();

// --- THE SECURITY FIREWALL ---
app.post("/api/login", (req, res) => {
    const { password } = req.body;  
    if (password === "Kilrrspicesadmin") { 
        res.setHeader('Set-Cookie', 'kilrr_auth=admin; Path=/; HttpOnly');
        return res.json({ success: true, role: 'admin' });
    } else if (password === "Kilrrspicesop") { 
        res.setHeader('Set-Cookie', 'kilrr_auth=operator; Path=/; HttpOnly');
        return res.json({ success: true, role: 'operator' });
    } else {
        return res.status(401).json({ success: false, error: "Invalid" });
    }
});

app.get("/api/logout", (req, res) => {
    res.setHeader('Set-Cookie', 'kilrr_auth=; Path=/; Max-Age=0');
    res.redirect('/login.html');
});

app.use((req, res, next) => {
    const url = req.path === '/' ? '/index.html' : req.path;
    if (url.endsWith('.html')) {
        if (url === '/login.html') return next(); 
        const cookies = req.headers.cookie || "";
        if (!cookies.includes("kilrr_auth=")) return res.redirect('/login.html'); 
        if (url === '/dashboard.html' || url === '/master.html') {
            if (!cookies.includes("kilrr_auth=admin")) {
                const sciFiDenied = `<!DOCTYPE html><html><head><title>SECURITY BREACH</title><style>body{background:#050505;color:#ff3333;font-family:sans-serif;display:flex;justify-content:center;align-items:center;height:100vh;} .box{text-align:center;border:2px solid red;padding:50px;} a{color:white;text-decoration:none;border:1px solid white;padding:10px;display:inline-block;margin-top:20px;}</style></head><body><div class="box"><h1>⚠️ RESTRICTED</h1><p>Manager Clearance Required.</p><a href="/">Return to Hub</a></div></body></html>`;
                return res.send(sciFiDenied);
            }
        }
    }
    next();
});

app.use(express.static("public"));

// --- POSTGRES APIs ---

// 1. INWARDING (Includes the Zero-Weight Fix for live inventory injection)
app.post("/log-inwarding", async (req, res) => {
    try {
        await pool.query("BEGIN");
        for(let item of req.body.queue) {
            await pool.query("INSERT INTO inwarding_logs (date_received, ingredient_name, ingredient_code, vendor_name, vendor_code, weight, packs) VALUES ($1, $2, $3, $4, $5, $6, $7)", [item.dateRaw, item.ingName, item.ingCode, item.venName, item.venCode, item.weight, item.packs]);
            
            // Inject tags directly into inventory so the scanner can read their weights instantly
            for(let i = item.startNo; i <= item.endNo; i++) {
                let generatedTag = `${item.dateFmt}/${item.ingCode}/${item.venCode}/${i}`;
                await pool.query("INSERT INTO inventory (rm_tag, product_code, original_weight, current_weight) VALUES ($1, $2, $3, $4) ON CONFLICT (rm_tag) DO NOTHING", [generatedTag, item.ingCode, item.weight, item.weight]);
            }
            
            pushToSheets("RM_INWARDING", "Receiver", { material: item.ingName, vendor: item.venName, weight_per_bag: item.weight, packs: item.packs });
        }
        await pool.query("COMMIT");
        res.json({ success: true });
    } catch(e) { await pool.query("ROLLBACK"); res.status(500).json({error: e.message}); }
});
app.get("/get-inwarding-logs", async (req, res) => {
    const result = await pool.query("SELECT * FROM inwarding_logs ORDER BY created_at DESC");
    res.json(result.rows);
});
app.post("/delete-inwarding-log", async (req, res) => {
    if (req.body.pin !== "1234") return res.status(403).json({ error: "Wrong PIN" });
    await pool.query("DELETE FROM inwarding_logs WHERE id = $1", [req.body.id]);
    res.json({ success: true });
});

// 2. SUB-ASSEMBLY & PRE-PROCESSING
app.post("/create-sub-assembly", async (req, res) => {
    const { parents, product_code, weight, process_type, operator } = req.body;
    try {
        await pool.query("BEGIN");
        const d = new Date();
        const ddmm = `${String(d.getDate()).padStart(2, '0')}${String(d.getMonth()+1).padStart(2, '0')}`;
        const randomId = Math.floor(1000 + Math.random() * 9000); 
        const subTag = `${ddmm}/${product_code}/SUB/${randomId}`;

        await pool.query(`INSERT INTO inventory (rm_tag, product_code, original_weight, current_weight, last_audited) VALUES ($1, $2, $3, $4, CURRENT_TIMESTAMP)`, [subTag, product_code, weight, weight]);
        
        for(let parentTag of parents) {
            await pool.query(`INSERT INTO sub_assemblies (sub_tag, parent_tag, process_type, operator) VALUES ($1, $2, $3, $4)`, [subTag, parentTag, process_type, operator]);
        }

        await pool.query("COMMIT");
        pushToSheets("SUB_ASSEMBLY_CREATED", operator, { sub_tag: subTag, process: process_type, material: product_code, output_weight: weight, parent_bags_used: parents.length });
        res.json({ success: true, sub_tag: subTag });
    } catch(e) { 
        await pool.query("ROLLBACK"); 
        res.status(500).json({error: e.message}); 
    }
});

// 3. AUDIT
app.post("/audit-stock", async (req, res) => {
    const { session_name, rm_tag, product_code, original_weight, current_weight } = req.body;
    try {
        await pool.query("BEGIN");
        await pool.query(`INSERT INTO audit_history (session_name, rm_tag, product_code, audited_weight) VALUES ($1, $2, $3, $4)`, [session_name, rm_tag, product_code, current_weight]);
        await pool.query(`INSERT INTO inventory (rm_tag, product_code, original_weight, current_weight, last_audited) VALUES ($1, $2, $3, $4, CURRENT_TIMESTAMP) ON CONFLICT(rm_tag) DO UPDATE SET current_weight = $5, last_audited = CURRENT_TIMESTAMP`, [rm_tag, product_code, original_weight, current_weight, current_weight]);
        await pool.query("COMMIT");
        pushToSheets("STOCK_AUDITED", session_name, { tag: rm_tag, material: product_code, prev_weight: original_weight, new_weight: current_weight });
        res.json({ success: true });
    } catch(e) { await pool.query("ROLLBACK"); res.status(500).json({error: e.message}); }
});
app.get("/get-inventory", async (req, res) => {
    const result = await pool.query("SELECT i.*, ing.ingredient_name FROM inventory i LEFT JOIN ingredients ing ON i.product_code = ing.product_code ORDER BY i.last_audited DESC");
    res.json(result.rows);
});
app.get("/audit-session/:session", async (req, res) => {
    const result = await pool.query(`SELECT a.session_name, a.rm_tag, a.product_code, a.audited_weight as current_weight, a.audited_at, i.original_weight, ing.ingredient_name FROM audit_history a LEFT JOIN inventory i ON a.rm_tag = i.rm_tag LEFT JOIN ingredients ing ON a.product_code = ing.product_code WHERE a.session_name = $1 ORDER BY a.audited_at DESC`, [req.params.session]);
    res.json(result.rows);
});
app.get("/get-sessions", async (req, res) => {
    const result = await pool.query("SELECT DISTINCT session_name FROM audit_history ORDER BY audited_at DESC");
    res.json(result.rows);
});
app.post("/delete-inventory", async (req, res) => {
    if (req.body.pin !== "1234") return res.status(403).json({ error: "Wrong PIN" });
    await pool.query("DELETE FROM inventory WHERE rm_tag = $1", [req.body.rm_tag]);
    await pool.query("DELETE FROM audit_history WHERE rm_tag = $1", [req.body.rm_tag]);
    res.json({ success: true });
});

// 4. MASTER DATA
app.post("/add-ingredient", async (req, res) => {
    await pool.query("INSERT INTO ingredients (product_code, ingredient_name) VALUES ($1, $2) ON CONFLICT (product_code) DO UPDATE SET ingredient_name = $2", [req.body.code.toUpperCase(), req.body.name]);
    res.json({ success: true });
});
app.get("/get-ingredients", async (req, res) => {
    const result = await pool.query("SELECT * FROM ingredients ORDER BY ingredient_name ASC");
    res.json(result.rows);
});
app.post("/delete-ingredient", async (req, res) => {
    if (req.body.pin !== "1234") return res.status(403).json({ error: "Wrong PIN" });
    await pool.query("DELETE FROM ingredients WHERE product_code = $1", [req.body.code.toUpperCase()]);
    res.json({ success: true });
});
app.post("/add-vendor", async (req, res) => {
    await pool.query("INSERT INTO vendors (vendor_code, vendor_name) VALUES ($1, $2) ON CONFLICT (vendor_code) DO UPDATE SET vendor_name = $2", [req.body.code.toUpperCase(), req.body.name]);
    res.json({ success: true });
});
app.get("/get-vendors", async (req, res) => {
    const result = await pool.query("SELECT * FROM vendors ORDER BY vendor_name ASC");
    res.json(result.rows);
});
app.post("/delete-vendor", async (req, res) => {
    if (req.body.pin !== "1234") return res.status(403).json({ error: "Wrong PIN" });
    await pool.query("DELETE FROM vendors WHERE vendor_code = $1", [req.body.code.toUpperCase()]);
    res.json({ success: true });
});
app.get("/get-recipes", async (req, res) => {
    const result = await pool.query("SELECT * FROM recipes");
    res.json(result.rows);
});
app.post("/update-recipe-secure", async (req, res) => {
    if (req.body.pin !== "1234") return res.status(403).json({ error: "Unauthorized" });
    try {
        await pool.query("BEGIN");
        await pool.query("DELETE FROM recipes WHERE fg_code = $1", [req.body.fg_code]);
        for(let code of req.body.ingredients) {
            await pool.query("INSERT INTO recipes (fg_code, product_code) VALUES ($1, $2)", [req.body.fg_code, code]);
        }
        await pool.query("COMMIT");
        pushToSheets("RECIPE_UPDATED", "Manager", { batch: req.body.fg_code, ingredients_count: req.body.ingredients.length });
        res.json({ success: true });
    } catch(e) { await pool.query("ROLLBACK"); res.status(500).json({error: e.message}); }
});

// 5. PRODUCTION BATCH ENGINE
app.get("/recipe-requirements/:fg", async (req, res) => {
    const result = await pool.query("SELECT r.product_code, i.ingredient_name FROM recipes r JOIN ingredients i ON r.product_code = i.product_code WHERE r.fg_code = $1", [req.params.fg]);
    res.json(result.rows);
});
app.get("/current-scans/:batch", async (req, res) => {
    const result = await pool.query(`
        SELECT s.product_code, s.rm_tag, i.ingredient_name, inv.current_weight as weight 
        FROM scans s 
        LEFT JOIN ingredients i ON s.product_code = i.product_code 
        LEFT JOIN inventory inv ON s.rm_tag = inv.rm_tag 
        WHERE s.batch_code = $1
    `, [req.params.batch]);
    res.json(result.rows);
});
app.get("/open-batches", async (req, res) => {
    const result = await pool.query("SELECT * FROM batches WHERE status = 'OPEN' ORDER BY created_at DESC");
    res.json(result.rows);
});
app.get("/all-batches", async (req, res) => {
    const result = await pool.query("SELECT * FROM batches ORDER BY created_at DESC");
    res.json(result.rows);
});
app.post("/create-batch", async (req, res) => {
    const opName = req.body.operator_name || "Unknown";
    try {
        await pool.query("INSERT INTO batches (batch_code, fg_code, operator_name) VALUES ($1, $2, $3)", [req.body.batch_code.toUpperCase(), req.body.fg_code, opName]);
        pushToSheets("BATCH_STARTED", opName, { batch: req.body.batch_code, material: req.body.fg_code });
        res.json({ success: true });
    } catch(e) { res.status(500).json({ error: "Batch already exists!" }); }
});
app.post("/scan", async (req, res) => {
    const parts = req.body.rm_tag.split("/");
    const pCode = parts.length >= 2 ? parts[1] : req.body.rm_tag;
    await pool.query("INSERT INTO scans (batch_code, rm_tag, product_code) VALUES ($1, $2, $3)", [req.body.batch_code, req.body.rm_tag, pCode]);
    pushToSheets("MATERIAL_SCANNED", "Operator", { batch: req.body.batch_code, tag: req.body.rm_tag, material: pCode });
    res.json({ success: true });
});
app.post("/delete-specific-scan", async (req, res) => {
    if (req.body.pin !== "1234") return res.status(403).json({ error: "Wrong PIN" });
    await pool.query("DELETE FROM scans WHERE batch_code = $1 AND rm_tag = $2", [req.body.batch_code, req.body.rm_tag]);
    pushToSheets("SCAN_VOIDED", "Manager", { batch: req.body.batch_code, voided_tag: req.body.rm_tag });
    res.json({ success: true });
});
app.post("/delete-batch", async (req, res) => {
    if (req.body.pin !== "1234") return res.status(403).json({ error: "Wrong PIN" });
    await pool.query("DELETE FROM batches WHERE batch_code = $1", [req.body.batch_code]);
    await pool.query("DELETE FROM scans WHERE batch_code = $1", [req.body.batch_code]);
    pushToSheets("BATCH_DELETED", "Manager", { locked_batch: req.body.batch_code });
    res.json({ success: true });
});
app.post("/lock-batch", async (req, res) => {
    await pool.query("UPDATE batches SET status = 'LOCKED' WHERE batch_code = $1", [req.body.batch_code]);
    pushToSheets("BATCH_FINALIZED", "Supervisor", { locked_batch: req.body.batch_code });
    res.json({ success: true });
});

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => console.log(`✅ Kilrr System Active on Port ${PORT}`));
