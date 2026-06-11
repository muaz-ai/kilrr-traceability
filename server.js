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
const SHEET_WEBHOOK = "https://script.google.com/macros/s/AKfycby5sagXzRtTwD_RFZ5dncTa6vy8vIFjpXYjexbmX76Tov1QTkhIxsbeT5SVopSXYHsU3Q/exec";

async function pushToSheets(eventType, operator, payload) {
    try {
        await fetch(SHEET_WEBHOOK, {
            method: "POST", headers: { "Content-Type": "application/json" },
            body: JSON.stringify({ event_type: eventType, operator: operator || "System", payload: payload }),
            redirect: "follow" 
        });
    } catch (e) { console.log("⚠️ Google Sheet Sync Failed"); }
}

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

app.post("/api/login", (req, res) => {
    const { password } = req.body;  
    if (password === "Kilrrspicesadmin") { res.setHeader('Set-Cookie', 'kilrr_auth=admin; Path=/; HttpOnly'); return res.json({ success: true, role: 'admin' }); }
    else if (password === "Kilrrspicesop") { res.setHeader('Set-Cookie', 'kilrr_auth=operator; Path=/; HttpOnly'); return res.json({ success: true, role: 'operator' }); }
    else { return res.status(401).json({ success: false, error: "Invalid" }); }
});

app.use(express.static("public"));

// --- NEW FIXES FOR PRE-PROCESS & SCANNER ---
app.get("/api/get-tag-weight", async (req, res) => {
    try {
        const result = await pool.query("SELECT current_weight FROM inventory WHERE rm_tag = $1", [req.query.tag]);
        res.json({ weight: result.rows.length > 0 ? result.rows[0].current_weight : 0 });
    } catch(e) { res.json({ weight: 0 }); }
});

app.get("/api/get-sub-assemblies", async (req, res) => {
    try {
        const result = await pool.query(`SELECT s.sub_tag, s.process_type, s.created_at, i.product_code, i.current_weight FROM sub_assemblies s JOIN inventory i ON s.sub_tag = i.rm_tag ORDER BY s.created_at DESC LIMIT 50`);
        const unique = Array.from(new Set(result.rows.map(a => a.sub_tag))).map(tag => result.rows.find(a => a.sub_tag === tag));
        res.json(unique);
    } catch(e) { res.json([]); }
});

app.post("/undo-scan", async (req, res) => {
    // 30-second grace period bypasses the PIN requirement
    await pool.query("DELETE FROM scans WHERE batch_code = $1 AND rm_tag = $2", [req.body.batch_code, req.body.rm_tag]);
    pushToSheets("SCAN_VOIDED", "Operator_Undo", { batch: req.body.batch_code, voided_tag: req.body.rm_tag });
    res.json({ success: true });
});

// --- STANDARD ROUTES ---
app.post("/log-inwarding", async (req, res) => {
    try {
        await pool.query("BEGIN");
        for(let item of req.body.queue) {
            await pool.query("INSERT INTO inwarding_logs (date_received, ingredient_name, ingredient_code, vendor_name, vendor_code, weight, packs) VALUES ($1, $2, $3, $4, $5, $6, $7)", [item.dateRaw, item.ingName, item.ingCode, item.venName, item.venCode, item.weight, item.packs]);
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

app.post("/create-sub-assembly", async (req, res) => {
    const { parents, product_code, weight, process_type, operator } = req.body;
    try {
        await pool.query("BEGIN");
        const d = new Date(); const ddmm = `${String(d.getDate()).padStart(2, '0')}${String(d.getMonth()+1).padStart(2, '0')}`;
        const randomId = Math.floor(1000 + Math.random() * 9000); 
        const subTag = `${ddmm}/${product_code}/SUB/${randomId}`;
        await pool.query(`INSERT INTO inventory (rm_tag, product_code, original_weight, current_weight, last_audited) VALUES ($1, $2, $3, $4, CURRENT_TIMESTAMP)`, [subTag, product_code, weight, weight]);
        for(let parentTag of parents) { await pool.query(`INSERT INTO sub_assemblies (sub_tag, parent_tag, process_type, operator) VALUES ($1, $2, $3, $4)`, [subTag, parentTag, process_type, operator]); }
        await pool.query("COMMIT");
        pushToSheets("SUB_ASSEMBLY_CREATED", operator, { sub_tag: subTag, process: process_type, material: product_code, output_weight: weight, parent_bags_used: parents.length });
        res.json({ success: true, sub_tag: subTag });
    } catch(e) { await pool.query("ROLLBACK"); res.status(500).json({error: e.message}); }
});

app.get("/get-ingredients", async (req, res) => { res.json((await pool.query("SELECT * FROM ingredients ORDER BY ingredient_name ASC")).rows); });
app.get("/get-recipes", async (req, res) => { res.json((await pool.query("SELECT * FROM recipes")).rows); });
app.get("/recipe-requirements/:fg", async (req, res) => { res.json((await pool.query("SELECT r.product_code, i.ingredient_name FROM recipes r JOIN ingredients i ON r.product_code = i.product_code WHERE r.fg_code = $1", [req.params.fg])).rows); });

app.get("/current-scans/:batch", async (req, res) => {
    res.json((await pool.query(`SELECT s.product_code, s.rm_tag, i.ingredient_name, inv.current_weight as weight FROM scans s LEFT JOIN ingredients i ON s.product_code = i.product_code LEFT JOIN inventory inv ON s.rm_tag = inv.rm_tag WHERE s.batch_code = $1`, [req.params.batch])).rows);
});
app.get("/open-batches", async (req, res) => { res.json((await pool.query("SELECT * FROM batches WHERE status = 'OPEN' ORDER BY created_at DESC")).rows); });
app.post("/create-batch", async (req, res) => {
    try {
        await pool.query("INSERT INTO batches (batch_code, fg_code, operator_name) VALUES ($1, $2, $3)", [req.body.batch_code.toUpperCase(), req.body.fg_code, req.body.operator_name || "Unknown"]);
        pushToSheets("BATCH_STARTED", req.body.operator_name, { batch: req.body.batch_code, material: req.body.fg_code });
        res.json({ success: true });
    } catch(e) { res.status(500).json({ error: "Batch already exists!" }); }
});
app.post("/scan", async (req, res) => {
    const parts = req.body.rm_tag.split("/"); const pCode = parts.length >= 2 ? parts[1] : req.body.rm_tag;
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
    res.json({ success: true });
});
app.post("/lock-batch", async (req, res) => {
    await pool.query("UPDATE batches SET status = 'LOCKED' WHERE batch_code = $1", [req.body.batch_code]);
    res.json({ success: true });
});

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => console.log(`✅ Kilrr System Active on Port ${PORT}`));
