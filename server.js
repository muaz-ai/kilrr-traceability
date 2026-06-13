const express = require("express");
const { Pool } = require("pg"); 
const bodyParser = require("body-parser");
const cors = require("cors");
const path = require('path');

const app = express();
app.use(cors());
app.use(bodyParser.json());

// ==========================================
// SYSTEM CONFIGURATION & DATABASE
// ==========================================
const pool = new Pool({
    connectionString: "postgresql://neondb_owner:npg_VgjU3LqG5Xou@ep-cold-cherry-a1yzxv4e-pooler.ap-southeast-1.aws.neon.tech/neondb?sslmode=require&channel_binding=require"
});

const SHEET_WEBHOOK = "YOUR_GOOGLE_APPS_SCRIPT_URL_HERE";

async function pushToSheets(eventType, operator, payload) {
    try {
        await fetch(SHEET_WEBHOOK, {
            method: "POST", 
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify({ 
                event_type: eventType, 
                operator: operator || "System", 
                payload: payload 
            }),
            redirect: "follow" 
        });
    } catch (e) {
        console.error("Sheet sync failed:", e);
    }
}

const initDB = async () => {
    try {
        // Standard Tables
        await pool.query(`CREATE TABLE IF NOT EXISTS batches (batch_code TEXT PRIMARY KEY, fg_code TEXT, status TEXT DEFAULT 'OPEN', created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP, operator_name TEXT)`);
        await pool.query(`CREATE TABLE IF NOT EXISTS scans (id SERIAL PRIMARY KEY, batch_code TEXT, rm_tag TEXT UNIQUE, product_code TEXT, scan_time TIMESTAMP DEFAULT CURRENT_TIMESTAMP)`);
        await pool.query(`CREATE TABLE IF NOT EXISTS ingredients (product_code TEXT PRIMARY KEY, ingredient_name TEXT)`);
        await pool.query(`CREATE TABLE IF NOT EXISTS vendors (vendor_code TEXT PRIMARY KEY, vendor_name TEXT)`);
        await pool.query(`CREATE TABLE IF NOT EXISTS recipes (fg_code TEXT, product_code TEXT, PRIMARY KEY(fg_code, product_code))`);
        await pool.query(`CREATE TABLE IF NOT EXISTS inventory (rm_tag TEXT PRIMARY KEY, product_code TEXT, original_weight REAL, current_weight REAL, last_audited TIMESTAMP DEFAULT CURRENT_TIMESTAMP)`);
        await pool.query(`CREATE TABLE IF NOT EXISTS inwarding_logs (id SERIAL PRIMARY KEY, date_received TEXT, ingredient_name TEXT, ingredient_code TEXT, vendor_name TEXT, vendor_code TEXT, weight REAL, packs INTEGER, created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP)`);
        await pool.query(`CREATE TABLE IF NOT EXISTS sub_assemblies (id SERIAL PRIMARY KEY, sub_tag TEXT, parent_tag TEXT, process_type TEXT, product_code TEXT, operator TEXT, created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP)`);
        
        // Continuous Pre-Process (Hopper) Tables
        await pool.query(`CREATE TABLE IF NOT EXISTS preprocess_jobs (job_code TEXT PRIMARY KEY, target_code TEXT, target_name TEXT, process_type TEXT, operator TEXT, status TEXT DEFAULT 'OPEN', created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP)`);
        await pool.query(`CREATE TABLE IF NOT EXISTS preprocess_scans (id SERIAL PRIMARY KEY, job_code TEXT, rm_tag TEXT UNIQUE, weight REAL, scan_time TIMESTAMP DEFAULT CURRENT_TIMESTAMP)`);

        // Database Patching for Traceability Upgrades
        try { await pool.query(`ALTER TABLE sub_assemblies ADD COLUMN IF NOT EXISTS product_code TEXT`); } catch(e){}
        try { await pool.query(`ALTER TABLE sub_assemblies ADD COLUMN IF NOT EXISTS parent_tag TEXT`); } catch(e){}
        try { await pool.query(`ALTER TABLE sub_assemblies DROP CONSTRAINT sub_assemblies_pkey`); } catch(e) {}
        
        console.log("✅ Kilrr Factory Engine Online & Database Patched");
    } catch(e) { 
        console.error("DB Init Error:", e); 
    }
};
initDB();

app.use(express.static("public"));

// ==========================================
// 1. MASTER DATA ROUTES
// ==========================================
app.get("/get-ingredients", async (req, res) => { 
    res.json((await pool.query("SELECT * FROM ingredients ORDER BY ingredient_name ASC")).rows); 
});

app.get("/get-vendors", async (req, res) => { 
    res.json((await pool.query("SELECT * FROM vendors ORDER BY vendor_name ASC")).rows); 
});

app.get("/get-recipes", async (req, res) => { 
    res.json((await pool.query("SELECT r.fg_code, r.product_code, i.ingredient_name FROM recipes r LEFT JOIN ingredients i ON r.product_code = i.product_code")).rows); 
});

app.post("/add-ingredient", async (req, res) => { 
    await pool.query("INSERT INTO ingredients (product_code, ingredient_name) VALUES ($1, $2) ON CONFLICT (product_code) DO UPDATE SET ingredient_name = $2", [req.body.code, req.body.name]); 
    res.json({ success: true }); 
});

app.post("/add-vendor", async (req, res) => { 
    await pool.query("INSERT INTO vendors (vendor_code, vendor_name) VALUES ($1, $2) ON CONFLICT (vendor_code) DO UPDATE SET vendor_name = $2", [req.body.code, req.body.name]); 
    res.json({ success: true }); 
});

app.post("/delete-ingredient", async (req, res) => { 
    if (req.body.pin !== "1234") return res.status(403).json({ error: "Unauthorized PIN" }); 
    await pool.query("DELETE FROM ingredients WHERE product_code = $1", [req.body.code]); 
    res.json({ success: true }); 
});

app.post("/delete-vendor", async (req, res) => { 
    if (req.body.pin !== "1234") return res.status(403).json({ error: "Unauthorized PIN" }); 
    await pool.query("DELETE FROM vendors WHERE vendor_code = $1", [req.body.code]); 
    res.json({ success: true }); 
});

app.post("/update-recipe-secure", async (req, res) => {
    if (req.body.pin !== "1234") return res.status(403).json({ error: "Unauthorized PIN" });
    try {
        await pool.query("BEGIN"); 
        await pool.query("DELETE FROM recipes WHERE fg_code = $1", [req.body.fg_code]);
        for(let code of req.body.ingredients) { 
            await pool.query("INSERT INTO recipes (fg_code, product_code) VALUES ($1, $2)", [req.body.fg_code, code]); 
        }
        await pool.query("COMMIT"); 
        pushToSheets("RECIPE_UPDATED", "Manager", { batch: req.body.fg_code, count: req.body.ingredients.length }); 
        res.json({ success: true });
    } catch(e) { 
        await pool.query("ROLLBACK"); 
        res.status(500).json({error: e.message}); 
    }
});

// ==========================================
// 2. INWARDING ROUTE
// ==========================================
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
    } catch(e) { 
        await pool.query("ROLLBACK"); 
        res.status(500).json({error: e.message}); 
    }
});

app.get("/api/get-tag-weight", async (req, res) => { 
    try { 
        const result = await pool.query("SELECT current_weight FROM inventory WHERE rm_tag = $1", [req.query.tag]); 
        res.json({ weight: result.rows.length > 0 ? result.rows[0].current_weight : 0 }); 
    } catch(e) { 
        res.json({ weight: 0 }); 
    } 
});

// ==========================================
// 3. CONTINUOUS PRE-PROCESS (THE HOPPER)
// ==========================================
app.get("/open-preprocess-jobs", async (req, res) => { 
    res.json((await pool.query("SELECT * FROM preprocess_jobs WHERE status = 'OPEN' ORDER BY created_at DESC")).rows); 
});

app.get("/preprocess-scans/:job", async (req, res) => { 
    res.json((await pool.query("SELECT * FROM preprocess_scans WHERE job_code = $1 ORDER BY scan_time DESC", [req.params.job])).rows); 
});

app.post("/create-preprocess-job", async (req, res) => {
    const { job_code, target_code, target_name, process_type, operator } = req.body;
    try {
        await pool.query("INSERT INTO preprocess_jobs (job_code, target_code, target_name, process_type, operator) VALUES ($1, $2, $3, $4, $5)", [job_code, target_code, target_name, process_type, operator]);
        res.json({ success: true });
    } catch(e) { 
        res.status(500).json({ error: "Job ID already exists!" }); 
    }
});

app.post("/scan-preprocess", async (req, res) => {
    try {
        const invRes = await pool.query("SELECT current_weight FROM inventory WHERE rm_tag = $1", [req.body.rm_tag]);
        const wt = invRes.rows.length > 0 ? invRes.rows[0].current_weight : 0;
        await pool.query("INSERT INTO preprocess_scans (job_code, rm_tag, weight) VALUES ($1, $2, $3)", [req.body.job_code, req.body.rm_tag, wt]);
        res.json({ success: true, weight: wt });
    } catch(e) { 
        res.status(400).json({ error: "Duplicate tag or DB error." }); 
    }
});

app.post("/undo-preprocess-scan", async (req, res) => {
    await pool.query("DELETE FROM preprocess_scans WHERE job_code = $1 AND rm_tag = $2", [req.body.job_code, req.body.rm_tag]);
    res.json({ success: true });
});

app.post("/close-preprocess-job", async (req, res) => {
    await pool.query("UPDATE preprocess_jobs SET status = 'CLOSED' WHERE job_code = $1", [req.body.job_code]);
    res.json({ success: true });
});

app.post("/create-sub-assembly-job", async (req, res) => {
    const { job_code, weight, packs } = req.body;
    
    // 1. Fetch the Job State
    const jobRes = await pool.query("SELECT * FROM preprocess_jobs WHERE job_code = $1", [job_code]);
    if(jobRes.rows.length === 0) return res.status(404).json({error: "Job not found"});
    const job = jobRes.rows[0];

    // 2. Fetch all parents currently in the hopper
    const scansRes = await pool.query("SELECT rm_tag FROM preprocess_scans WHERE job_code = $1", [job_code]);
    const parentTags = scansRes.rows.map(r => r.rm_tag);

    const numPacks = parseInt(packs) || 1;
    const weightPerPack = (parseFloat(weight) / numPacks).toFixed(2);
    
    try {
        await pool.query("BEGIN");
        const d = new Date(); 
        const dateCode = `${String(d.getDate()).padStart(2, '0')}${String(d.getMonth()+1).padStart(2, '0')}`;
        const baseId = Math.floor(1000 + Math.random() * 9000);
        let generatedTags = [];
        
        for(let i = 1; i <= numPacks; i++) {
            const subTag = `${dateCode}/${job.target_code}/SUB/${baseId}/${i}`;
            generatedTags.push({ tag: subTag, weight: weightPerPack });
            
            await pool.query(`INSERT INTO inventory (rm_tag, product_code, original_weight, current_weight) VALUES ($1, $2, $3, $4)`, [subTag, job.target_code, weightPerPack, weightPerPack]);
            
            // Map the child tag back to all parents in the hopper
            if(parentTags.length > 0) {
                for(let pTag of parentTags) {
                    await pool.query(`INSERT INTO sub_assemblies (sub_tag, parent_tag, process_type, product_code, operator) VALUES ($1, $2, $3, $4, $5)`, [subTag, pTag, job.process_type, job.target_code, job.operator]);
                }
            } else {
                await pool.query(`INSERT INTO sub_assemblies (sub_tag, parent_tag, process_type, product_code, operator) VALUES ($1, $2, $3, $4, $5)`, [subTag, 'MANUAL_ENTRY', job.process_type, job.target_code, job.operator]);
            }
        }
        await pool.query("COMMIT");
        res.json({ success: true, tags: generatedTags, process_type: job.process_type, target_name: job.target_name, target_code: job.target_code });
    } catch(e) { 
        await pool.query("ROLLBACK"); 
        res.status(500).json({error: e.message}); 
    }
});

// ==========================================
// 4. BATCH SCANNER ROUTES
// ==========================================
app.get("/open-batches", async (req, res) => { 
    res.json((await pool.query("SELECT * FROM batches WHERE status = 'OPEN' ORDER BY created_at DESC")).rows); 
});

app.get("/recipe-requirements/:fg", async (req, res) => { 
    res.json((await pool.query("SELECT r.product_code, i.ingredient_name FROM recipes r LEFT JOIN ingredients i ON r.product_code = i.product_code WHERE r.fg_code = $1", [req.params.fg])).rows); 
});

app.get("/current-scans/:batch", async (req, res) => { 
    res.json((await pool.query(`SELECT s.rm_tag, s.product_code, i.ingredient_name, inv.current_weight as weight FROM scans s LEFT JOIN ingredients i ON s.product_code = i.product_code LEFT JOIN inventory inv ON s.rm_tag = inv.rm_tag WHERE s.batch_code = $1`, [req.params.batch])).rows); 
});

app.post("/create-batch", async (req, res) => { 
    try { 
        await pool.query("INSERT INTO batches (batch_code, fg_code, operator_name) VALUES ($1, $2, $3)", [req.body.batch_code, req.body.fg_code, req.body.operator_name]); 
        pushToSheets("BATCH_STARTED", req.body.operator_name, { batch: req.body.batch_code, material: req.body.fg_code }); 
        res.json({ success: true }); 
    } catch(e) { 
        res.status(500).json({ error: "Batch ID already exists!" }); 
    } 
});

app.post("/scan", async (req, res) => { 
    const parts = req.body.rm_tag.split("/"); 
    const pCode = parts.length >= 2 ? parts[1] : req.body.rm_tag; 
    try { 
        await pool.query("INSERT INTO scans (batch_code, rm_tag, product_code) VALUES ($1, $2, $3)", [req.body.batch_code, req.body.rm_tag, pCode]); 
        pushToSheets("MATERIAL_SCANNED", req.body.operator, { batch: req.body.batch_code, tag: req.body.rm_tag, material: pCode }); 
        res.json({ success: true }); 
    } catch(e) { 
        res.status(400).json({ error: "Duplicate scan or DB error." }); 
    } 
});

app.post("/undo-scan", async (req, res) => { 
    await pool.query("DELETE FROM scans WHERE batch_code = $1 AND rm_tag = $2", [req.body.batch_code, req.body.rm_tag]); 
    res.json({ success: true }); 
});

app.post("/delete-batch", async (req, res) => { 
    if (req.body.pin !== "1234") return res.status(403).json({ error: "Wrong PIN" }); 
    await pool.query("DELETE FROM batches WHERE batch_code = $1", [req.body.batch_code]); 
    await pool.query("DELETE FROM scans WHERE batch_code = $1", [req.body.batch_code]); 
    res.json({ success: true }); 
});

// ==========================================
// 5. MASTER DASHBOARD TRACEABILITY
// ==========================================
app.get("/api/dashboard-traceability", async (req, res) => {
    try {
        const batches = await pool.query("SELECT * FROM batches ORDER BY created_at DESC LIMIT 100");
        
        const allScans = await pool.query(`
            SELECT 
                s.batch_code, s.rm_tag, s.product_code, i.ingredient_name, inv.current_weight as weight, 
                STRING_AGG(DISTINCT sub.parent_tag, ', ') as parent_tags 
            FROM scans s 
            LEFT JOIN ingredients i ON s.product_code = i.product_code 
            LEFT JOIN inventory inv ON s.rm_tag = inv.rm_tag 
            LEFT JOIN sub_assemblies sub ON s.rm_tag = sub.sub_tag 
            GROUP BY s.id, s.batch_code, s.rm_tag, s.product_code, i.ingredient_name, inv.current_weight
        `);
        
        const responseData = batches.rows.map(batch => { 
            const batchScans = allScans.rows.filter(scan => scan.batch_code === batch.batch_code); 
            const totalWeight = batchScans.reduce((sum, scan) => sum + (parseFloat(scan.weight) || 0), 0); 
            return { ...batch, total_weight: totalWeight, scans: batchScans }; 
        });
        
        res.json(responseData);
    } catch(e) { 
        res.status(500).json({error: e.message}); 
    }
});

// ==========================================
// LAUNCH SERVER
// ==========================================
const PORT = process.env.PORT || 3000;
app.listen(PORT, () => console.log(`✅ Kilrr Factory Engine Online on Port ${PORT}`));
