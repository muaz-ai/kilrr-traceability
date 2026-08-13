const express = require('express');
const path = require('path');
const { Pool } = require('pg');
const https = require('https');

try { require('dotenv').config(); } catch (e) { console.log("Local .env not found, relying on cloud variables."); }

const app = express();
app.use(express.json({ limit: '10mb' })); // Allows large yield arrays to be saved

try { const cors = require('cors'); app.use(cors()); } catch (e) {}

app.use(express.static('public'));

// ==========================================
// 1. CLOUD DATABASE & SECURITY CONFIG
// ==========================================
const SHEET_WEBHOOK = process.env.SHEET_WEBHOOK || ""; 
const MASTER_PASSWORD = "1234"; // PIN locked to 1234

if (!process.env.DATABASE_URL) {
    console.error("🚨 CRITICAL FATAL ERROR: DATABASE_URL is missing! Render cannot connect to Neon.");
}

const pool = new Pool({
    connectionString: process.env.DATABASE_URL,
    ssl: { rejectUnauthorized: false },
    connectionTimeoutMillis: 15000 
});

// The Engine that pushes live data to Google Sheets
function backupToSheets(eventType, operator, payload) {
    if(!SHEET_WEBHOOK || !SHEET_WEBHOOK.startsWith('https')) return;
    try {
        const data = JSON.stringify({ event_type: eventType, operator: operator, payload: payload });
        const req = https.request(SHEET_WEBHOOK, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(data) }
        });
        req.on('error', (e) => console.error("Sheets Backup Error:", e.message));
        req.write(data);
        req.end();
    } catch(e) {
        console.error("Backup trigger failed, but database is safe.");
    }
}

// ==========================================
// 2. THE SCHEMA PATCHER (DATABASE AUTO-BUILDER)
// ==========================================
async function initDB() {
    try {
        console.log("🛠 Starting Database Architecture Check...");
        await pool.query(`
            CREATE TABLE IF NOT EXISTS ingredients (product_code VARCHAR(100) PRIMARY KEY, ingredient_name VARCHAR(255));
            CREATE TABLE IF NOT EXISTS vendors (vendor_code VARCHAR(100) PRIMARY KEY, vendor_name VARCHAR(255));
            CREATE TABLE IF NOT EXISTS recipes (id SERIAL PRIMARY KEY, fg_code VARCHAR(100), ingredient_code VARCHAR(100));
            CREATE TABLE IF NOT EXISTS inwarding_logs (id SERIAL PRIMARY KEY, date_received DATE, ingredient_code VARCHAR(100), ingredient_name VARCHAR(255), vendor_code VARCHAR(100), vendor_name VARCHAR(255), weight DECIMAL, start_no INT, end_no INT, packs INT, created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP);
            CREATE TABLE IF NOT EXISTS sub_assemblies (id SERIAL PRIMARY KEY, sub_tag VARCHAR(255), product_code VARCHAR(100), process_type VARCHAR(100), parent_tag TEXT, total_yield VARCHAR(50), batch_code VARCHAR(100), created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP);
            CREATE TABLE IF NOT EXISTS batches (batch_code VARCHAR(100) PRIMARY KEY, fg_code VARCHAR(100), operator_name VARCHAR(100), status VARCHAR(50) DEFAULT 'OPEN', total_weight DECIMAL DEFAULT 0, created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP);
            CREATE TABLE IF NOT EXISTS scans (id SERIAL PRIMARY KEY, batch_code VARCHAR(100) REFERENCES batches(batch_code) ON DELETE CASCADE, rm_tag VARCHAR(255) UNIQUE, product_code VARCHAR(100), weight DECIMAL DEFAULT 0, operator VARCHAR(100), parent_tags TEXT, created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP);
            
            -- Yield Tracking Table
            CREATE TABLE IF NOT EXISTS yield_logs (
                batch_code VARCHAR(100) PRIMARY KEY, 
                date DATE, 
                product_code VARCHAR(100), 
                target_wt DECIMAL, 
                tare_grams INT, 
                total_runs INT, 
                total_pkts INT, 
                total_gross DECIMAL, 
                total_tare DECIMAL, 
                total_net DECIMAL, 
                loss_pct DECIMAL, 
                yield_pct DECIMAL, 
                runs_data TEXT, 
                created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
            );
        `);

        // Safely apply schema updates without dropping existing data
        const patches = [
            `ALTER TABLE scans ADD COLUMN IF NOT EXISTS weight DECIMAL DEFAULT 0;`,
            `ALTER TABLE scans ADD COLUMN IF NOT EXISTS operator VARCHAR(100);`,
            `ALTER TABLE scans ADD COLUMN IF NOT EXISTS parent_tags TEXT;`,
            `ALTER TABLE scans ADD COLUMN IF NOT EXISTS created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP;`,
            `ALTER TABLE batches ADD COLUMN IF NOT EXISTS total_weight DECIMAL DEFAULT 0;`,
            `ALTER TABLE inwarding_logs ADD COLUMN IF NOT EXISTS start_no INT;`,
            `ALTER TABLE inwarding_logs ADD COLUMN IF NOT EXISTS end_no INT;`,
            `ALTER TABLE inwarding_logs ADD COLUMN IF NOT EXISTS packs INT;`
        ];
        
        for (let patch of patches) { try { await pool.query(patch); } catch(e) {} }
        console.log("✅ Kilrr OS Database Connected & Secured.");
    } catch (e) { console.error("❌ DB Init Error:", e.message); }
}
initDB();

// ==========================================
// 3. SECURED MASTER DATA ROUTES
// ==========================================

app.get("/get-ingredients", async (req, res) => {
    try { res.json((await pool.query("SELECT * FROM ingredients ORDER BY ingredient_name")).rows); } 
    catch(e) { res.status(500).json({error: e.message}); }
});

app.post("/add-ingredient", async (req, res) => {
    if(req.body.master_key !== MASTER_PASSWORD) return res.status(403).json({error: "ACCESS DENIED: Invalid Master Password."});
    try { 
        await pool.query("INSERT INTO ingredients (product_code, ingredient_name) VALUES ($1, $2) ON CONFLICT (product_code) DO UPDATE SET ingredient_name = $2", [req.body.code, req.body.name]); 
        res.json({status: "success"}); 
    } catch(e) { res.status(500).json({error: e.message}); }
});

app.post("/delete-ingredient", async (req, res) => {
    if(req.body.master_key !== MASTER_PASSWORD) return res.status(403).json({error: "ACCESS DENIED"});
    try {
        await pool.query("DELETE FROM ingredients WHERE product_code = $1", [req.body.code]);
        res.json({status: "success"});
    } catch(e) { res.status(500).json({error: e.message}); }
});

app.get("/get-vendors", async (req, res) => {
    try { res.json((await pool.query("SELECT * FROM vendors ORDER BY vendor_name")).rows); } 
    catch(e) { res.status(500).json({error: e.message}); }
});

app.post("/add-vendor", async (req, res) => {
    if(req.body.master_key !== MASTER_PASSWORD) return res.status(403).json({error: "ACCESS DENIED: Invalid Master Password."});
    try { 
        await pool.query("INSERT INTO vendors (vendor_code, vendor_name) VALUES ($1, $2) ON CONFLICT (vendor_code) DO UPDATE SET vendor_name = $2", [req.body.code, req.body.name]); 
        res.json({status: "success"}); 
    } catch(e) { res.status(500).json({error: e.message}); }
});

app.post("/delete-vendor", async (req, res) => {
    if(req.body.master_key !== MASTER_PASSWORD) return res.status(403).json({error: "ACCESS DENIED"});
    try {
        await pool.query("DELETE FROM vendors WHERE vendor_code = $1", [req.body.code]);
        res.json({status: "success"});
    } catch(e) { res.status(500).json({error: e.message}); }
});

app.get("/get-recipes", async (req, res) => {
    try { res.json((await pool.query("SELECT * FROM recipes")).rows); } 
    catch(e) { res.status(500).json({error: e.message}); }
});

app.post("/update-recipe", async (req, res) => {
    if(req.body.master_key !== MASTER_PASSWORD) return res.status(403).json({error: "ACCESS DENIED: Invalid Master Password."});
    try {
        const { fg_code, ingredients } = req.body;
        await pool.query("DELETE FROM recipes WHERE fg_code ILIKE $1", [fg_code]);
        if(ingredients) {
            const codes = ingredients.split(',').map(c => c.trim().toUpperCase());
            for(let code of codes) {
                await pool.query("INSERT INTO recipes (fg_code, ingredient_code) VALUES ($1, $2)", [fg_code, code]);
            }
        }
        res.json({status: "success"});
    } catch(e) { res.status(500).json({error: e.message}); }
});

// ==========================================
// 4. FACTORY FLOOR ROUTES (INWARD & PRE-PROCESS)
// ==========================================

app.get("/api/last-inward", async (req, res) => {
    try {
        const { date, ing, ven } = req.query;
        const result = await pool.query("SELECT MAX(end_no) as last_no FROM inwarding_logs WHERE date_received = $1 AND ingredient_code ILIKE $2 AND vendor_code ILIKE $3", [date, ing, ven]);
        res.json(result.rows[0]);
    } catch(e) { res.status(500).json({error: e.message}); }
});

app.get("/api/tag-weight", async (req, res) => {
    try {
        let tag = req.query.tag;
        let parts = tag.split('/');
        let pCode = parts.length >= 2 ? parts[1] : tag;
        let weight = 0;
        let inw = await pool.query("SELECT weight FROM inwarding_logs WHERE ingredient_code ILIKE $1 ORDER BY created_at DESC LIMIT 1", [pCode]);
        if(inw.rows.length > 0) weight = parseFloat(inw.rows[0].weight) || 0;
        res.json({ weight: weight });
    } catch(e) { res.status(500).json({weight: 0}); }
});

app.post("/log-inwarding", async (req, res) => {
    try {
        const { queue } = req.body;
        for(let item of queue) {
            let safeWeight = parseFloat(item.weight) || 0;
            await pool.query("INSERT INTO inwarding_logs (date_received, ingredient_code, ingredient_name, vendor_code, vendor_name, weight, start_no, end_no, packs) VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9)", [item.dateRaw, item.ingCode, item.ingName, item.venCode, item.venName, safeWeight, item.startNo, item.endNo, item.packs]);
            
            // 📡 LIVE SHEET SYNC
            backupToSheets("INWARD_LOGGED", "System", item);
        }
        res.json({status: "success"});
    } catch(e) { res.status(500).json({error: e.message}); }
});

app.post("/log-preprocess", async (req, res) => {
    try {
        const { output_tags, product_code, process_type, parent_tags, total_yield, batch_code } = req.body;
        for(let tag of output_tags) {
            await pool.query("INSERT INTO sub_assemblies (sub_tag, product_code, process_type, parent_tag, total_yield, batch_code) VALUES ($1, $2, $3, $4, $5, $6)", [tag, product_code, process_type, parent_tags, total_yield, batch_code]);
        }
        
        // 📡 LIVE SHEET SYNC
        let outRange = output_tags.length > 1 ? `${output_tags[0]} to ${output_tags[output_tags.length-1]}` : output_tags[0];
        backupToSheets("WIP_LOGGED", "System", { batch_code, product_code, process_type, parent_tags, total_yield, outputs: outRange });

        res.json({status: "success"});
    } catch(e) { res.status(500).json({error: e.message}); }
});

// ==========================================
// 5. SCANNER ROUTES (BATCH EXECUTION)
// ==========================================

app.get("/open-batches", async (req, res) => {
    try { res.json((await pool.query("SELECT * FROM batches WHERE status = 'OPEN' ORDER BY created_at DESC")).rows); } 
    catch(e) { res.status(500).json({error: e.message}); }
});

app.get("/closed-batches", async (req, res) => {
    try { res.json((await pool.query("SELECT * FROM batches WHERE status = 'CLOSED' ORDER BY created_at DESC LIMIT 20")).rows); } 
    catch(e) { res.status(500).json({error: e.message}); }
});

app.post("/create-batch", async (req, res) => {
    try {
        await pool.query("INSERT INTO batches (batch_code, fg_code, operator_name) VALUES ($1, $2, $3)", [req.body.batch_code, req.body.fg_code, req.body.operator_name]);
        
        // 📡 LIVE SHEET SYNC
        backupToSheets("FINAL_BATCH", req.body.operator_name, req.body);

        res.json({status: "success"});
    } catch(e) {
        if(e.code === '23505') return res.status(400).json({error: "Batch code already exists!"});
        res.status(500).json({error: e.message});
    }
});

app.get("/recipe-requirements/:fg_code", async (req, res) => {
    try {
        const result = await pool.query(`SELECT r.ingredient_code as product_code, i.ingredient_name FROM recipes r LEFT JOIN ingredients i ON r.ingredient_code = i.product_code WHERE r.fg_code ILIKE $1`, [req.params.fg_code]);
        res.json(result.rows);
    } catch(e) { res.status(500).json({error: e.message}); }
});

app.post("/scan", async (req, res) => {
    try {
        const { batch_code, rm_tag, operator } = req.body;
        let parts = rm_tag.split('/');
        let pCode = parts.length >= 2 ? parts[1] : rm_tag;
        let vCode = parts.length >= 3 ? parts[2] : null;
        
        let w = 0; 
        let pTags = null;

        // Extract internal tags vs raw material tags
        if(vCode === 'KILRR') {
            let wip = await pool.query("SELECT parent_tag FROM sub_assemblies WHERE sub_tag = $1", [rm_tag]);
            if(wip.rows.length > 0) pTags = wip.rows[0].parent_tag;
        } else {
            let inw = await pool.query("SELECT weight FROM inwarding_logs WHERE ingredient_code ILIKE $1 ORDER BY created_at DESC LIMIT 1", [pCode]);
            if(inw.rows.length > 0) w = parseFloat(inw.rows[0].weight) || 0;
        }

        await pool.query("INSERT INTO scans (batch_code, rm_tag, product_code, weight, operator, parent_tags) VALUES ($1, $2, $3, $4, $5, $6)", [batch_code, rm_tag, pCode, w, operator, pTags]);
        await pool.query("UPDATE batches SET total_weight = COALESCE(total_weight, 0) + $1 WHERE batch_code = $2", [w, batch_code]);
        
        // 📡 LIVE SHEET SYNC: Individual Scan Data
        backupToSheets("SCAN_LOGGED", operator, { batch_code, rm_tag, product_code: pCode, weight: w });

        res.json({status: "success"});
    } catch(e) { res.status(500).json({error: e.message}); }
});

app.post("/undo-scan", async (req, res) => {
    try {
        const d = await pool.query("SELECT weight FROM scans WHERE batch_code = $1 AND rm_tag = $2", [req.body.batch_code, req.body.rm_tag]);
        if(d.rows.length > 0) {
            let w = parseFloat(d.rows[0].weight) || 0;
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

app.post("/close-batch", async (req, res) => {
    try {
        await pool.query("UPDATE batches SET status = 'CLOSED' WHERE batch_code = $1", [req.body.batch_code]);
        res.json({status: "success"});
    } catch(e) { res.status(500).json({error: e.message}); }
});

app.post("/delete-batch", async (req, res) => {
    if(req.body.pin !== MASTER_PASSWORD) return res.status(403).json({error: "ACCESS DENIED: Invalid Master Password."});
    try {
        await pool.query("DELETE FROM batches WHERE batch_code = $1", [req.body.batch_code]);
        res.json({status: "success"});
    } catch(e) { res.status(500).json({error: e.message}); }
});

// ==========================================
// 6. YIELD & RECONCILIATION ROUTES
// ==========================================

app.post("/log-yield", async (req, res) => {
    try {
        const { batch_code, date, product_code, target_wt, tare_grams, total_runs, total_pkts, total_gross, total_tare, total_net, loss_pct, yield_pct, runs_data, is_edit } = req.body;

        // Enforce duplicate logic
        if(!is_edit) {
            let check = await pool.query("SELECT batch_code FROM yield_logs WHERE batch_code = $1", [batch_code]);
            if(check.rows.length > 0) return res.status(400).json({error: "Duplicate Batch Code! This batch already exists. Go to the Dashboard to edit it."});
        }

        await pool.query(
            `INSERT INTO yield_logs (batch_code, date, product_code, target_wt, tare_grams, total_runs, total_pkts, total_gross, total_tare, total_net, loss_pct, yield_pct, runs_data)
             VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13)
             ON CONFLICT (batch_code) DO UPDATE SET
             date=$2, product_code=$3, target_wt=$4, tare_grams=$5, total_runs=$6, total_pkts=$7, total_gross=$8, total_tare=$9, total_net=$10, loss_pct=$11, yield_pct=$12, runs_data=$13, created_at=CURRENT_TIMESTAMP`,
            [batch_code, date, product_code, target_wt, tare_grams, total_runs, total_pkts, total_gross, total_tare, total_net, loss_pct, yield_pct, runs_data]
        );

        // 📡 LIVE SHEET SYNC
        if(!is_edit) backupToSheets("YIELD_LOGGED", "System", req.body);

        res.json({status: "success"});
    } catch(e) { res.status(500).json({error: e.message}); }
});

app.post("/delete-yield", async (req, res) => {
    if(req.body.pin !== MASTER_PASSWORD) return res.status(403).json({error: "ACCESS DENIED: Invalid Master Password."});
    try {
        await pool.query("DELETE FROM yield_logs WHERE batch_code = $1", [req.body.batch_code]);
        res.json({status: "success"});
    } catch(e) { res.status(500).json({error: e.message}); }
});

// ==========================================
// 7. DASHBOARD TRACEABILITY ROUTES
// ==========================================

app.get("/api/dashboard-traceability", async (req, res) => {
    try {
        const b = await pool.query("SELECT * FROM batches ORDER BY created_at DESC LIMIT 50");
        const s = await pool.query("SELECT s.*, i.ingredient_name FROM scans s LEFT JOIN ingredients i ON s.product_code = i.product_code");
        const result = b.rows.map(x => ({ ...x, scans: s.rows.filter(y => y.batch_code === x.batch_code) }));
        res.json(result);
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

app.get("/api/dashboard-yield", async (req, res) => {
    try { res.json((await pool.query("SELECT * FROM yield_logs ORDER BY created_at DESC LIMIT 200")).rows); }
    catch(e) { res.status(500).json({error: e.message}); }
});

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => console.log(`🚀 Kilrr OS Engine Running on port ${PORT}`));
