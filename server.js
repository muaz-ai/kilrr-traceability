const express = require('express');
const path = require('path');
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

async function initDB() {
    try {
        console.log("🛠 Starting Emergency Database Patch...");
        
        // 1. Ensure tables exist
        await pool.query(`
            CREATE TABLE IF NOT EXISTS inwarding_logs (id SERIAL PRIMARY KEY, date_received DATE, ingredient_code VARCHAR(100), ingredient_name VARCHAR(255), vendor_code VARCHAR(100), vendor_name VARCHAR(255), weight DECIMAL, start_no INT, end_no INT, packs INT, created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP);
            CREATE TABLE IF NOT EXISTS sub_assemblies (id SERIAL PRIMARY KEY, sub_tag VARCHAR(255), product_code VARCHAR(100), process_type VARCHAR(100), parent_tag TEXT, total_yield VARCHAR(50), batch_code VARCHAR(100), created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP);
            CREATE TABLE IF NOT EXISTS batches (batch_code VARCHAR(100) PRIMARY KEY, fg_code VARCHAR(100), operator_name VARCHAR(100), status VARCHAR(50) DEFAULT 'OPEN', total_weight DECIMAL DEFAULT 0, created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP);
            CREATE TABLE IF NOT EXISTS scans (id SERIAL PRIMARY KEY, batch_code VARCHAR(100) REFERENCES batches(batch_code) ON DELETE CASCADE, rm_tag VARCHAR(255) UNIQUE, product_code VARCHAR(100), weight DECIMAL DEFAULT 0, operator VARCHAR(100), parent_tags TEXT, created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP);
        `);

        // 2. FORCE-PATCH: Add missing columns if they don't exist
        const patches = [
            `ALTER TABLE scans ADD COLUMN IF NOT EXISTS weight DECIMAL DEFAULT 0;`,
            `ALTER TABLE scans ADD COLUMN IF NOT EXISTS operator VARCHAR(100);`,
            `ALTER TABLE scans ADD COLUMN IF NOT EXISTS parent_tags TEXT;`,
            `ALTER TABLE scans ADD COLUMN IF NOT EXISTS created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP;`,
            `ALTER TABLE batches ADD COLUMN IF NOT EXISTS total_weight DECIMAL DEFAULT 0;`
        ];
        for (let p of patches) { try { await pool.query(p); } catch(e) { console.log("Patch skip:", e.message); } }
        
        console.log("✅ Database Patch Complete.");
    } catch (e) { console.error("❌ DB Init Error:", e.message); }
}
initDB();

// --- ROUTES ---
app.get("/get-recipes", async (req, res) => {
    try { res.json((await pool.query("SELECT * FROM recipes")).rows); }
    catch(e) { res.status(500).json({error: e.message}); }
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
        let pCode = rm_tag.split('/')[1] || rm_tag;
        let w = 0; 
        let inw = await pool.query("SELECT weight FROM inwarding_logs WHERE ingredient_code ILIKE $1 ORDER BY created_at DESC LIMIT 1", [pCode]);
        if(inw.rows.length > 0) w = parseFloat(inw.rows[0].weight) || 0;

        await pool.query("INSERT INTO scans (batch_code, rm_tag, product_code, weight, operator) VALUES ($1, $2, $3, $4, $5)", [batch_code, rm_tag, pCode, w, operator]);
        await pool.query("UPDATE batches SET total_weight = COALESCE(total_weight, 0) + $1 WHERE batch_code = $2", [w, batch_code]);
        res.json({status: "success"});
    } catch(e) { res.status(500).json({error: e.message}); }
});

app.get("/current-scans/:batch_code", async (req, res) => {
    try { res.json((await pool.query("SELECT * FROM scans WHERE batch_code = $1 ORDER BY created_at DESC", [req.params.batch_code])).rows); }
    catch(e) { res.status(500).json({error: e.message}); }
});

app.get("/api/dashboard-traceability", async (req, res) => {
    try {
        const b = await pool.query("SELECT * FROM batches ORDER BY created_at DESC LIMIT 50");
        const s = await pool.query("SELECT s.*, i.ingredient_name FROM scans s LEFT JOIN ingredients i ON s.product_code = i.product_code");
        res.json(b.rows.map(x => ({...x, scans: s.rows.filter(y => y.batch_code === x.batch_code)})));
    } catch(e) { res.status(500).json({error: e.message}); }
});

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => console.log(`🚀 Engine Running`));
