const express = require("express");
const { Pool } = require("pg"); 
const bodyParser = require("body-parser");
const cors = require("cors");
const path = require('path');

const app = express();
app.use(cors());
app.use(bodyParser.json());

// --- NEON CLOUD DATABASE ---
const pool = new Pool({
    connectionString: "postgresql://neondb_owner:npg_VgjU3LqG5Xou@ep-cold-cherry-a1yzxv4e-pooler.ap-southeast-1.aws.neon.tech/neondb?sslmode=require&channel_binding=require"
});

// --- GOOGLE SHEETS WEBHOOK ---
const SHEET_WEBHOOK = "https://script.google.com/macros/s/AKfycby5sagXzRtTwD_RFZ5dncTa6vy8vIFjpXYjexbmX76Tov1QTkhIxsbeT5SVopSXYHsU3Q/exec";

async function pushToSheets(eventType, operator, payload) {
    try {
        await fetch(SHEET_WEBHOOK, {
            method: "POST", headers: { "Content-Type": "application/json" },
            body: JSON.stringify({ event_type: eventType, operator: operator || "System", payload: payload }),
            redirect: "follow" 
        });
    } catch (e) { console.log("Google Sheet Sync Failed"); }
}

const initDB = async () => {
    try {
        await pool.query(`CREATE TABLE IF NOT EXISTS batches (batch_code TEXT PRIMARY KEY, fg_code TEXT, status TEXT DEFAULT 'OPEN', created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP, operator_name TEXT)`);
        await pool.query(`CREATE TABLE IF NOT EXISTS scans (id SERIAL PRIMARY KEY, batch_code TEXT, rm_tag TEXT UNIQUE, product_code TEXT, scan_time TIMESTAMP DEFAULT CURRENT_TIMESTAMP)`);
        await pool.query(`CREATE TABLE IF NOT EXISTS ingredients (product_code TEXT PRIMARY KEY, ingredient_name TEXT)`);
        await pool.query(`CREATE TABLE IF NOT EXISTS vendors (vendor_code TEXT PRIMARY KEY, vendor_name TEXT)`);
        await pool.query(`CREATE TABLE IF NOT EXISTS recipes (fg_code TEXT, product_code TEXT, PRIMARY KEY(fg_code, product_code))`);
        await pool.query(`CREATE TABLE IF NOT EXISTS inventory (rm_tag TEXT PRIMARY KEY, product_code TEXT, original_weight REAL, current_weight REAL, last_audited TIMESTAMP DEFAULT CURRENT_TIMESTAMP)`);
        await pool.query(`CREATE TABLE IF NOT EXISTS sub_assemblies (sub_tag TEXT PRIMARY KEY, process_type TEXT, product_code TEXT, operator TEXT, created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP)`);
        console.log("✅ Kilrr Database Initialized");
    } catch(e) { console.error("DB Init Error:", e); }
};
initDB();

app.use(express.static("public"));

// --- MASTER DATA ROUTES (Fixed Wipe Bug) ---
app.get("/get-ingredients", async (req, res) => { res.json((await pool.query("SELECT * FROM ingredients ORDER BY ingredient_name ASC")).rows); });
app.get("/get-vendors", async (req, res) => { res.json((await pool.query("SELECT * FROM vendors ORDER BY vendor_name ASC")).rows); });
app.get("/get-recipes", async (req, res) => { 
    res.json((await pool.query("SELECT r.fg_code, r.product_code, i.ingredient_name FROM recipes r LEFT JOIN ingredients i ON r.product_code = i.product_code")).rows); 
});

app.post("/add-ingredient", async (req, res) => {
    await pool.query("INSERT INTO ingredients (product_code, ingredient_name) VALUES ($1, $2) ON CONFLICT (product_code) DO UPDATE SET ingredient_name = $2", [req.body.code, req.body.name]);
    res.json({ success: true });
});

app.post("/update-recipe-secure", async (req, res) => {
    if (req.body.pin !== "1234") return res.status(403).json({ error: "Unauthorized PIN" });
    if (!req.body.ingredients || req.body.ingredients.length === 0) return res.status(400).json({ error: "No ingredients provided" });
    
    try {
        await pool.query("BEGIN");
        await pool.query("DELETE FROM recipes WHERE fg_code = $1", [req.body.fg_code]);
        for(let code of req.body.ingredients) {
            await pool.query("INSERT INTO recipes (fg_code, product_code) VALUES ($1, $2)", [req.body.fg_code, code]);
        }
        await pool.query("COMMIT");
        pushToSheets("RECIPE_UPDATED", "Manager", { batch: req.body.fg_code, count: req.body.ingredients.length });
        res.json({ success: true });
    } catch(e) { await pool.query("ROLLBACK"); res.status(500).json({error: e.message}); }
});

// --- PRE-PROCESS ROUTES ---
app.get("/api/get-tag-weight", async (req, res) => {
    try {
        const result = await pool.query("SELECT current_weight FROM inventory WHERE rm_tag = $1", [req.query.tag]);
        res.json({ weight: result.rows.length > 0 ? result.rows[0].current_weight : 0 });
    } catch(e) { res.json({ weight: 0 }); }
});

app.post("/create-sub-assembly", async (req, res) => {
    const { product_code, weight, process_type, operator } = req.body;
    try {
        await pool.query("BEGIN");
        const d = new Date(); const dateCode = `${String(d.getDate()).padStart(2, '0')}${String(d.getMonth()+1).padStart(2, '0')}`;
        const subTag = `${dateCode}/${product_code}/SUB/${Math.floor(1000 + Math.random() * 9000)}`;
        
        await pool.query(`INSERT INTO inventory (rm_tag, product_code, original_weight, current_weight) VALUES ($1, $2, $3, $4)`, [subTag, product_code, weight, weight]);
        await pool.query(`INSERT INTO sub_assemblies (sub_tag, process_type, product_code, operator) VALUES ($1, $2, $3, $4)`, [subTag, process_type, product_code, operator]);
        
        await pool.query("COMMIT");
        pushToSheets("SUB_ASSEMBLY_CREATED", operator, { sub_tag: subTag, process: process_type, material: product_code, output_weight: weight });
        res.json({ success: true, sub_tag: subTag });
    } catch(e) { await pool.query("ROLLBACK"); res.status(500).json({error: e.message}); }
});

// --- SCANNER & BATCH ROUTES ---
app.get("/open-batches", async (req, res) => { res.json((await pool.query("SELECT * FROM batches WHERE status = 'OPEN' ORDER BY created_at DESC")).rows); });
app.get("/recipe-requirements/:fg", async (req, res) => { res.json((await pool.query("SELECT product_code FROM recipes WHERE fg_code = $1", [req.params.fg])).rows); });

app.get("/current-scans/:batch", async (req, res) => {
    res.json((await pool.query(`SELECT s.rm_tag, s.product_code, inv.current_weight as weight FROM scans s LEFT JOIN inventory inv ON s.rm_tag = inv.rm_tag WHERE s.batch_code = $1`, [req.params.batch])).rows);
});

app.post("/create-batch", async (req, res) => {
    try {
        await pool.query("INSERT INTO batches (batch_code, fg_code, operator_name) VALUES ($1, $2, $3)", [req.body.batch_code, req.body.fg_code, req.body.operator_name]);
        pushToSheets("BATCH_STARTED", req.body.operator_name, { batch: req.body.batch_code, material: req.body.fg_code });
        res.json({ success: true });
    } catch(e) { res.status(500).json({ error: "Batch ID already exists!" }); }
});

app.post("/scan", async (req, res) => {
    const parts = req.body.rm_tag.split("/"); const pCode = parts.length >= 2 ? parts[1] : req.body.rm_tag;
    try {
        await pool.query("INSERT INTO scans (batch_code, rm_tag, product_code) VALUES ($1, $2, $3)", [req.body.batch_code, req.body.rm_tag, pCode]);
        pushToSheets("MATERIAL_SCANNED", "Operator", { batch: req.body.batch_code, tag: req.body.rm_tag, material: pCode });
        res.json({ success: true });
    } catch(e) { res.status(400).json({ error: "Tag already scanned or duplicate." }); }
});

app.post("/undo-scan", async (req, res) => {
    await pool.query("DELETE FROM scans WHERE batch_code = $1 AND rm_tag = $2", [req.body.batch_code, req.body.rm_tag]);
    pushToSheets("SCAN_VOIDED", "Operator_Undo", { batch: req.body.batch_code, voided_tag: req.body.rm_tag });
    res.json({ success: true });
});

// --- DASHBOARD TRACEABILITY ---
app.get("/api/dashboard-traceability", async (req, res) => {
    try {
        const batches = await pool.query("SELECT * FROM batches ORDER BY created_at DESC LIMIT 100");
        const allScans = await pool.query(`SELECT s.batch_code, s.rm_tag, s.product_code, i.ingredient_name, inv.current_weight as weight FROM scans s LEFT JOIN ingredients i ON s.product_code = i.product_code LEFT JOIN inventory inv ON s.rm_tag = inv.rm_tag`);
        
        const responseData = batches.rows.map(batch => {
            const batchScans = allScans.rows.filter(scan => scan.batch_code === batch.batch_code);
            const totalWeight = batchScans.reduce((sum, scan) => sum + (parseFloat(scan.weight) || 0), 0);
            return { ...batch, total_weight: totalWeight, scans: batchScans };
        });
        res.json(responseData);
    } catch(e) { res.status(500).json({error: e.message}); }
});

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => console.log(`✅ Kilrr Engine Online on Port ${PORT}`));
