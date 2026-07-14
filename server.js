const express = require('express');
const path = require('path');
const { Pool } = require('pg');
const https = require('https');

// SHIELD 1: Safely loads your Neon Database Key without crashing Render
try { require('dotenv').config(); } catch (e) {}

const app = express();
app.use(express.json());

// SHIELD 2: Safely loads network rules without crashing
try { const cors = require('cors'); app.use(cors()); } catch (e) {}

app.use(express.static('public'));

// ==========================================
// 1. CLOUD DATABASE & BACKUP SETUP
// ==========================================
const SHEET_WEBHOOK = process.env.SHEET_WEBHOOK || ""; 

const pool = new Pool({
    connectionString: process.env.DATABASE_URL,
    ssl: { rejectUnauthorized: false }
});

// The Indestructible Cloud Backup Trigger (100% Native)
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
        console.error("Backup execution failed, but DB is safe.");
    }
}

// Auto-Create FSSAI Tables
async function initDB() {
    try {
        await pool.query(`
            CREATE TABLE IF NOT EXISTS ingredients (
                product_code VARCHAR(100) PRIMARY KEY,
                ingredient_name VARCHAR(255)
            );
            CREATE TABLE IF NOT EXISTS vendors (
                vendor_code VARCHAR(100) PRIMARY KEY,
                vendor_name VARCHAR(255)
            );
            CREATE TABLE IF NOT EXISTS recipes (
                id SERIAL PRIMARY KEY,
                fg_code VARCHAR(100),
                ingredient_code VARCHAR(100)
            );
            CREATE TABLE IF NOT EXISTS inwarding_logs (
                id SERIAL PRIMARY KEY,
                date_received DATE,
                ingredient_code VARCHAR(100),
                ingredient_name VARCHAR(255),
                vendor_code VARCHAR(100),
                vendor_name VARCHAR(255),
                weight DECIMAL,
                start_no INT,
                end_no INT,
                packs INT,
                created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
            );
            CREATE TABLE IF NOT EXISTS sub_assemblies (
                id SERIAL PRIMARY KEY,
                sub_tag VARCHAR(255),
                product_code VARCHAR(100),
                process_type VARCHAR(100),
                parent_tag TEXT,
                total_yield VARCHAR(50),
                batch_code VARCHAR(100),
                created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
            );
            CREATE TABLE IF NOT EXISTS batches (
                batch_code VARCHAR(100) PRIMARY KEY,
                fg_code VARCHAR(100),
                operator_name VARCHAR(100),
                status VARCHAR(50) DEFAULT 'OPEN',
                total_weight DECIMAL DEFAULT 0,
                created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
            );
            CREATE TABLE IF NOT EXISTS scans (
                id SERIAL PRIMARY KEY,
                batch_code VARCHAR(100) REFERENCES batches(batch_code) ON DELETE CASCADE,
                rm_tag VARCHAR(255) UNIQUE,
                product_code VARCHAR(100),
                weight DECIMAL DEFAULT 0,
                operator VARCHAR(100),
                parent_tags TEXT,
                created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
            );
        `);
        console.log("✅ Kilrr OS Database Architecture Verified & Locked.");
    } catch (e) {
        console.error("❌ Database Initialization Error:", e);
    }
}
initDB();

// ==========================================
// 2. MASTER DATA ROUTES 
// ==========================================
app.get("/get-ingredients", async (req, res) => {
    try { res.json((await pool.query("SELECT * FROM ingredients ORDER BY ingredient_name")).rows); }
    catch(e) { res.status(500).json({error: e.message}); }
});

app.get("/get-vendors", async (req, res) => {
    try { res.json((await pool.query("SELECT * FROM vendors ORDER BY vendor_name")).rows); }
    catch(e) { res.status(500).json({error: e.message}); }
});

app.get("/get-recipes", async (req, res) => {
    try { res.json((await pool.query("SELECT * FROM recipes")).rows); }
    catch(e) { res.status(500).json({error: e.message}); }
});

// ==========================================
// 3. INWARDING ROUTES
// ==========================================
app.post("/log-inwarding", async (req, res) => {
    try {
        const { queue } = req.body;
        for(let item of queue) {
            await pool.query(
                "INSERT INTO inwarding_logs (date_received, ingredient_code, ingredient_name, vendor_code, vendor_name, weight, start_no, end_no, packs) VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9)",
                [item.dateRaw, item.ingCode, item.ingName, item.venCode, item.venName, item.weight, item.startNo, item.endNo, item.packs]
            );
            backupToSheets("INWARD_LOGGED", "System", item);
        }
        res.json({status: "success"});
    } catch(e) { res.status(500).json({error: e.message}); }
});

// ==========================================
// 4. PRE-PROCESS ROUTES
// ==========================================
app.post("/log-preprocess", async (req, res) => {
    try {
        const { output_tags, product_code, process_type, parent_tags, total_yield, batch_code } = req.body;
        for(let tag of output_tags) {
            await pool.query(
                "INSERT INTO sub_assemblies (sub_tag, product_code, process_type, parent_tag, total_yield, batch_code) VALUES ($1, $2, $3, $4, $5, $6)",
                [tag, product_code, process_type, parent_tags, total_yield, batch_code]
            );
        }
        backupToSheets("PREPROCESS_LOGGED", "System", req.body);
        res.json({status: "success"});
    } catch(e) { res.status(500).json({error: e.message}); }
});

// ==========================================
// 5. SCANNER ROUTES
// ==========================================
app.get("/open-batches", async (req, res) => {
    try { res.json((await pool.query("SELECT * FROM batches WHERE status = 'OPEN' ORDER BY created_at DESC")).rows); }
    catch(e) { res.status(500).json({error: e.message}); }
});

app.post("/create-batch", async (req, res) => {
    try {
        const { batch_code, fg_code, operator_name } = req.body;
        await pool.query("INSERT INTO batches (batch_code, fg_code, operator_name) VALUES ($1, $2, $3)", [batch_code, fg_code, operator_name]);
        backupToSheets("BATCH_STARTED", operator_name, { batch_code, fg_code });
        res.json({status: "success"});
    } catch(e) {
        if(e.code === '23505') return res.status(400).json({error: "Batch code already exists!"});
        res.status(500).json({error: e.message});
    }
});

app.get("/recipe-requirements/:fg_code", async (req, res) => {
    try {
        const fgCode = req.params.fg_code;
        const result = await pool.query(`SELECT r.ingredient_code as product_code, i.ingredient_name FROM recipes r LEFT JOIN ingredients i ON r.ingredient_code = i.product_code WHERE r.fg_code = $1`, [fgCode]);
        res.json(result.rows);
    } catch(e) { res.status(500).json({error: e.message}); }
});

app.post("/scan", async (req, res) => {
    try {
        const { batch_code, rm_tag, operator } = req.body;
        let parts = rm_tag.split('/');
        let product_code = parts.length >= 2 ? parts[1] : rm_tag;
        let vendor_code = parts.length >= 3 ? parts[2] : null;
        let weight = 0; let parent_tags = null;

        if (vendor_code === 'KILRR') {
            let wip = await pool.query("SELECT parent_tag FROM sub_assemblies WHERE sub_tag = $1", [rm_tag]);
            if(wip.rows.length > 0) parent_tags = wip.rows[0].parent_tag;
        } else {
            let inw = await pool.query("SELECT weight FROM inwarding_logs WHERE ingredient_code = $1 AND vendor_code = $2 ORDER BY created_at DESC LIMIT 1", [product_code, vendor_code]);
            if(inw.rows.length > 0) weight = inw.rows[0].weight;
        }

        await pool.query("INSERT INTO scans (batch_code, rm_tag, product_code, weight, operator, parent_tags) VALUES ($1, $2, $3, $4, $5, $6)", [batch_code, rm_tag, product_code, weight, operator, parent_tags]);
        await pool.query("UPDATE batches SET total_weight = total_weight + $1 WHERE batch_code = $2", [weight, batch_code]);
        backupToSheets("SCAN_ADDED", operator, { batch_code, rm_tag, product_code, weight, parent_tags });
        res.json({status: "success"});
    } catch(e) {
        if(e.code === '23505') return res.status(400).json({error: "Duplicate tag!"});
        res.status(500).json({error: e.message});
    }
});

app.post("/undo-scan", async (req, res) => {
    try {
        const { batch_code, rm_tag } = req.body;
        const scanData = await pool.query("SELECT weight FROM scans WHERE batch_code = $1 AND rm_tag = $2", [batch_code, rm_tag]);
        if(scanData.rows.length > 0) {
            let w = scanData.rows[0].weight || 0;
            await pool.query("DELETE FROM scans WHERE batch_code = $1 AND rm_tag = $2", [batch_code, rm_tag]);
            await pool.query("UPDATE batches SET total_weight = total_weight - $1 WHERE batch_code = $2", [w, batch_code]);
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
        const { pin, batch_code } = req.body;
        if(pin !== "1234") return res.status(403).json({error: "Unauthorized"});
        await pool.query("DELETE FROM batches WHERE batch_code = $1", [batch_code]);
        res.json({status: "success"});
    } catch(e) { res.status(500).json({error: e.message}); }
});

// ==========================================
// 6. DASHBOARD ROUTES
// ==========================================
app.get("/api/dashboard-traceability", async (req, res) => {
    try {
        const batches = await pool.query("SELECT * FROM batches ORDER BY created_at DESC LIMIT 50");
        const scans = await pool.query("SELECT s.*, i.ingredient_name FROM scans s LEFT JOIN ingredients i ON s.product_code = i.product_code");
        let result = batches.rows.map(b => { b.scans = scans.rows.filter(s => s.batch_code === b.batch_code); return b; });
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

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => console.log(`🏭 Kilrr OS Engine running globally on port ${PORT}`));
