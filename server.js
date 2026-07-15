const express = require('express');
const { Pool } = require('pg');
const https = require('https');

try { require('dotenv').config(); } catch (e) {}

const app = express();
app.use(express.json());

try { const cors = require('cors'); app.use(cors()); } catch (e) {}

app.use(express.static('public'));

const SHEET_WEBHOOK = process.env.SHEET_WEBHOOK || ""; 

const pool = new Pool({
    connectionString: process.env.DATABASE_URL,
    ssl: { rejectUnauthorized: false },
    connectionTimeoutMillis: 15000 
});

function backupToSheets(eventType, operator, payload) {
    if(!SHEET_WEBHOOK || !SHEET_WEBHOOK.startsWith('https')) return;
    try {
        const data = JSON.stringify({ event_type: eventType, operator: operator, payload: payload });
        const req = https.request(SHEET_WEBHOOK, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(data) }
        });
        req.write(data); req.end();
    } catch(e) {}
}

async function initDB() {
    try {
        await pool.query(`
            CREATE TABLE IF NOT EXISTS ingredients (product_code VARCHAR(100) PRIMARY KEY, ingredient_name VARCHAR(255));
            CREATE TABLE IF NOT EXISTS vendors (vendor_code VARCHAR(100) PRIMARY KEY, vendor_name VARCHAR(255));
            CREATE TABLE IF NOT EXISTS recipes (id SERIAL PRIMARY KEY, fg_code VARCHAR(100), ingredient_code VARCHAR(100));
            CREATE TABLE IF NOT EXISTS inwarding_logs (id SERIAL PRIMARY KEY, date_received DATE, ingredient_code VARCHAR(100), ingredient_name VARCHAR(255), vendor_code VARCHAR(100), vendor_name VARCHAR(255), weight DECIMAL, start_no INT, end_no INT, packs INT, created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP);
            CREATE TABLE IF NOT EXISTS sub_assemblies (id SERIAL PRIMARY KEY, sub_tag VARCHAR(255), product_code VARCHAR(100), process_type VARCHAR(100), parent_tag TEXT, total_yield VARCHAR(50), batch_code VARCHAR(100), created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP);
            CREATE TABLE IF NOT EXISTS batches (batch_code VARCHAR(100) PRIMARY KEY, fg_code VARCHAR(100), operator_name VARCHAR(100), status VARCHAR(50) DEFAULT 'OPEN', total_weight DECIMAL DEFAULT 0, created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP);
            CREATE TABLE IF NOT EXISTS scans (id SERIAL PRIMARY KEY, batch_code VARCHAR(100) REFERENCES batches(batch_code) ON DELETE CASCADE, rm_tag VARCHAR(255) UNIQUE, product_code VARCHAR(100), weight DECIMAL DEFAULT 0, operator VARCHAR(100), parent_tags TEXT, created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP);
        `);
        console.log("✅ Kilrr OS Database Connected & Verified.");
    } catch (e) { console.error("❌ DB Init Error:", e.message); }
}
initDB();

// --- MASTER DATA ROUTES ---
app.get("/get-ingredients", async (req, res) => {
    try { res.json((await pool.query("SELECT * FROM ingredients ORDER BY ingredient_name")).rows); }
    catch(e) { res.status(500).json({error: e.message}); }
});
app.post("/add-ingredient", async (req, res) => {
    try { await pool.query("INSERT INTO ingredients (product_code, ingredient_name) VALUES ($1, $2) ON CONFLICT (product_code) DO UPDATE SET ingredient_name = $2", [req.body.code, req.body.name]); res.json({status: "success"}); }
    catch(e) { res.status(500).json({error: e.message}); }
});
app.get("/get-vendors", async (req, res) => {
    try { res.json((await pool.query("SELECT * FROM vendors ORDER BY vendor_name")).rows); }
    catch(e) { res.status(500).json({error: e.message}); }
});
app.post("/add-vendor", async (req, res) => {
    try { await pool.query("INSERT INTO vendors (vendor_code, vendor_name) VALUES ($1, $2) ON CONFLICT (vendor_code) DO UPDATE SET vendor_name = $2", [req.body.code, req.body.name]); res.json({status: "success"}); }
    catch(e) { res.status(500).json({error: e.message}); }
});
app.get("/get-recipes", async (req, res) => {
    try { res.json((await pool.query("SELECT * FROM recipes")).rows); }
    catch(e) { res.status(500).json({error: e.message}); }
});
app.post("/update-recipe", async (req, res) => {
    try {
        const { fg_code, ingredients, pin } = req.body;
        if(pin !== "1234") return res.status(403).json({error: "Invalid PIN."});
        await pool.query("DELETE FROM recipes WHERE fg_code ILIKE $1", [fg_code]);
        if(ingredients) {
            const codes = ingredients.split(',').map(c => c.trim().toUpperCase());
            for(let code of codes) await pool.query("INSERT INTO recipes (fg_code, ingredient_code) VALUES ($1, $2)", [fg_code, code]);
        }
        res.json({status: "success"});
    } catch(e) { res.status(500).json({error: e.message}); }
});
app.get("/recipe-requirements/:fg_code", async (req, res) => {
    try {
        const result = await pool.query(`SELECT r.ingredient_code as product_code, i.ingredient_name FROM recipes r LEFT JOIN ingredients i ON r.ingredient_code = i.product_code WHERE r.fg_code ILIKE $1`, [req.params.fg_code]);
        res.json(result.rows);
    } catch(e) { res.status(500).json({error: e.message}); }
});

// --- FACTORY TRACEABILITY ROUTES ---
app.post("/log-inwarding", async (req, res) => {
    try {
        const { queue } = req.body;
        for(let item of queue) {
            await pool.query("INSERT INTO inwarding_logs (date_received, ingredient_code, ingredient_name, vendor_code, vendor_name, weight, start_no, end_no, packs) VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9)", [item.dateRaw, item.ingCode, item.ingName, item.venCode, item.venName, parseFloat(item.weight)||0, item.startNo, item.endNo, item.packs]);
            backupToSheets("INWARD_LOGGED", "System", item);
        }
        res.json({status: "success"});
    } catch(e) { res.status(500).json({error: e.message}); }
});

app.post("/log-preprocess", async (req, res) => {
    try {
        const { output_tags, product_code, process_type, parent_tags, total_yield, batch_code } = req.body;
        for(let tag of output_tags) await pool.query("INSERT INTO sub_assemblies (sub_tag, product_code, process_type, parent_tag, total_yield, batch_code) VALUES ($1, $2, $3, $4, $5, $6)", [tag, product_code, process_type, parent_tags, total_yield, batch_code]);
        res.json({status: "success"});
    } catch(e) { res.status(500).json({error: e.message}); }
});

app.get("/open-batches", async (req, res) => {
    try { res.json((await pool.query("SELECT * FROM batches WHERE status = 'OPEN' ORDER BY created_at DESC")).rows); }
    catch(e) { res.status(500).json({error: e.message}); }
});

app.post("/create-batch", async (req, res) => {
    try {
        await pool.query("INSERT INTO batches (batch_code, fg_code, operator_name) VALUES ($1, $2, $3)", [req.body.batch_code, req.body.fg_code, req.body.operator_name]);
        res.json({status: "success"});
    } catch(e) {
        if(e.code === '23505') return res.status(400).json({error: "Batch code already exists!"});
        res.status(500).json({error: e.message});
    }
});

app.post("/scan", async (req, res) => {
    try {
        const { batch_code, rm_tag, operator } = req.body;
        let parts = rm_tag.split('/'), pCode = parts.length>=2 ? parts[1] : rm_tag, vCode = parts.length>=3 ? parts[2] : null;
        let w = 0, pTags = null;
        if(vCode === 'KILRR') {
            let wip = await pool.query("SELECT parent_tag FROM sub_assemblies WHERE sub_tag = $1", [rm_tag]);
            if(wip.rows.length > 0) pTags = wip.rows[0].parent_tag;
        } else {
            let inw = await pool.query("SELECT weight FROM inwarding_logs WHERE ingredient_code ILIKE $1 ORDER BY created_at DESC LIMIT 1", [pCode]);
            if(inw.rows.length > 0) w = parseFloat(inw.rows[0].weight) || 0;
        }
        await pool.query("INSERT INTO scans (batch_code, rm_tag, product_code, weight, operator, parent_tags) VALUES ($1, $2, $3, $4, $5, $6)", [batch_code, rm_tag, pCode, w, operator, pTags]);
        await pool.query("UPDATE batches SET total_weight = COALESCE(total_weight, 0) + $1 WHERE batch_code = $2", [w, batch_code]);
        res.json({status: "success"});
    } catch(e) { res.status(500).json({error: e.message}); }
});

app.post("/undo-scan", async (req, res) => {
    try {
        const d = await pool.query("SELECT weight FROM scans WHERE batch_code = $1 AND rm_tag = $2", [req.body.batch_code, req.body.rm_tag]);
        if(d.rows.length > 0) {
            let w = parseFloat(d.rows[0].weight)||0;
            await pool.query("DELETE FROM scans WHERE batch_code = $1 AND rm_tag = $2", [req.body.batch_code, req.body.rm_tag]);
            await pool.query("UPDATE batches SET total_weight = COALESCE(total_weight, 0) - $1 WHERE batch_code = $2", [w, req.body.batch_code]);
        }
        res.json({status: "success"});
    } catch(e) { res.status(500).json({error: e.message}); }
});

app.get("/current-scans/:batch_code", async (req, res) => {
    try { res.json((await pool.query("SELECT * FROM scans WHERE batch_code = $1 ORDER BY created_at DESC", [req.params.batch_code])).rows); }
    catch(e) { res.status(500).json({error: e.message}); }
});

app.post("/delete-batch", async (req, res) => {
    try {
        await pool.query("DELETE FROM batches WHERE batch_code = $1", [req.body.batch_code]);
        res.json({status: "success"});
    } catch(e) { res.status(500).json({error: e.message}); }
});

// --- DASHBOARD ROUTES ---
app.get("/api/dashboard-traceability", async (req, res) => {
    try {
        const b = await pool.query("SELECT * FROM batches ORDER BY created_at DESC LIMIT 50");
        const s = await pool.query("SELECT s.*, i.ingredient_name FROM scans s LEFT JOIN ingredients i ON s.product_code = i.product_code");
        res.json(b.rows.map(x => ({...x, scans: s.rows.filter(y => y.batch_code === x.batch_code)})));
    } catch(e) { res.status(500).json({error: e.message}); }
});
app.get("/api/dashboard-inwarding", async (req, res) => {
    try { res.json((await pool.query("SELECT * FROM inwarding_logs ORDER BY created_at DESC LIMIT 200")).rows); }
    catch(e) { res.status(500).json({error: e.message}); }
});
app.get("/api/dashboard-preprocess", async (req, res) => {
    try { res.json((await pool.query("SELECT * FROM sub_assemblies ORDER BY created_at DESC LIMIT 200")).rows); }
    catch(e) { res.status(500).json({error: e.message}); }
});

app.listen(process.env.PORT || 3000, () => console.log(`🚀 Engine Running`));
