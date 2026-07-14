<!DOCTYPE html>
<html lang="en">
<head>
    <meta charset="UTF-8">
    <title>Kilrr OS - Traceability Dashboard</title>
    <meta name="viewport" content="width=device-width, initial-scale=1.0">
    <link href="https://fonts.googleapis.com/css2?family=Inter:wght@400;600;700;800;900&family=Space+Grotesk:wght@700;900&display=swap" rel="stylesheet">
    <script src="https://cdnjs.cloudflare.com/ajax/libs/xlsx/0.18.5/xlsx.full.min.js"></script>
    <style>
        :root { --kilrr-orange: #ea580c; --navy-command: #0b1121; --success-green: #059669; }
        body { font-family: 'Inter', sans-serif; background: #f1f5f9; color: #0f172a; margin: 0; padding-bottom: 50px;}
        .nav-top { background: var(--navy-command); border-bottom: 4px solid var(--kilrr-orange); padding: 15px 20px; display: flex; justify-content: space-between; align-items: center;}
        .brand { font-family: 'Space Grotesk', sans-serif; font-size: 26px; font-weight: 900; color: white; text-decoration: none; text-transform: uppercase; letter-spacing: 1px;}
        .brand span { color: var(--kilrr-orange); }
        .nav-links { display: flex; gap: 10px; }
        .nav-btn { color: #cbd5e1; text-decoration: none; font-weight: 700; font-size: 13px; text-transform: uppercase; padding: 8px 12px; border-radius: 8px;}
        .nav-btn:hover { background: rgba(255,255,255,0.1); color: white;}
        .nav-btn.active { color: var(--kilrr-orange); }

        .container { max-width: 1200px; margin: 30px auto; padding: 0 15px; }
        
        .header-row { display: flex; justify-content: space-between; align-items: flex-end; margin-bottom: 20px;}
        h2 { font-family: 'Space Grotesk', sans-serif; font-size: 28px; text-transform: uppercase; color: var(--navy-command); margin:0;}
        .sub-heading { font-weight: 700; color: #64748b; font-size: 14px; margin-top: 5px;}
        
        .btn-export { background: linear-gradient(135deg, #059669, #047857); color: white; border: none; padding: 12px 20px; border-radius: 8px; font-weight: 900; font-size: 14px; cursor: pointer; text-transform: uppercase; box-shadow: 0 4px 10px rgba(5, 150, 105, 0.3);}

        .table-header { display: grid; grid-template-columns: 1.5fr 2fr 1fr 1fr 1fr 1fr; background: var(--navy-command); color: white; padding: 15px 20px; border-radius: 12px 12px 0 0; font-weight: 900; font-size: 12px; text-transform: uppercase; letter-spacing: 1px;}
        
        .batch-row { background: white; border: 1px solid #cbd5e1; border-top: none; padding: 15px 20px; display: grid; grid-template-columns: 1.5fr 2fr 1fr 1fr 1fr 1fr; align-items: center; font-weight: 700; cursor: pointer; transition: 0.2s;}
        .batch-row:hover { background: #fff7ed; }
        .batch-row:last-child { border-radius: 0 0 12px 12px; }
        
        .b-code { color: var(--kilrr-orange); font-family: monospace; font-size: 16px;}
        .b-recipe { font-weight: 900; font-size: 15px;}
        .b-weight { color: var(--success-green); font-weight: 900;}
        .b-status { background: #e0f2fe; color: #2563eb; font-size: 11px; padding: 4px 10px; border-radius: 20px; display: inline-block; width: fit-content;}
        .b-status.closed { background: #f1f5f9; color: #64748b; }
        .b-date { color: #64748b; font-size: 13px; font-weight: 600;}

        .scan-drawer { background: #f8fafc; border: 1px solid #cbd5e1; border-top: none; padding: 20px; display: none; border-left: 4px solid var(--kilrr-orange);}
        .scan-grid { display: flex; flex-wrap: wrap; gap: 10px; }
        .scan-pill { background: white; border: 1px solid #cbd5e1; padding: 10px 15px; border-radius: 8px; font-size: 13px; font-weight: 700; display: flex; flex-direction: column; box-shadow: 0 2px 4px rgba(0,0,0,0.02); min-width: 150px;}
        .scan-pill span { color: #64748b; font-size: 11px; font-weight: 800; margin-bottom: 3px; font-family: monospace;}
        .scan-pill .wgt { color: var(--success-green); font-size: 14px; font-weight: 900; margin-top: 5px;}
    </style>
</head>
<body>
    <nav class="nav-top">
        <a href="index.html" class="brand">Kilrr <span>OS</span></a>
        <div class="nav-links">
            <a href="index.html" class="nav-btn">Hub</a>
            <a href="inwarding.html" class="nav-btn">Inward</a>
            <a href="preprocess.html" class="nav-btn">Pre-Process</a>
            <a href="scanner.html" class="nav-btn">Scanner</a>
            <a href="dashboard.html" class="nav-btn active">Dashboard</a>
            <a href="master.html" class="nav-btn">Master</a>
        </div>
    </nav>

    <div class="container">
        <div class="header-row">
            <div>
                <h2>Master Traceability Engine</h2>
                <div class="sub-heading">Click on any batch to view the ingredient breakdown and parent origins.</div>
            </div>
            <button class="btn-export" onclick="exportToExcel()">⬇ Export to Excel</button>
        </div>

        <div class="table-header">
            <div>Batch Code</div>
            <div>Recipe</div>
            <div>Total Weight</div>
            <div>Operator</div>
            <div>Status</div>
            <div>Started</div>
        </div>
        
        <div id="batch_list">
            <div style="background:white; padding:40px; text-align:center; color:#94a3b8; font-weight:bold; border: 1px solid #cbd5e1; border-top: none;">Loading Traceability Data...</div>
        </div>
    </div>

    <script>
        let rawData = [];

        window.onload = async () => {
            try {
                const res = await fetch('/api/dashboard-traceability');
                rawData = await res.json();
                renderDashboard();
            } catch(e) {
                document.getElementById('batch_list').innerHTML = `<div style="background:white; padding:40px; text-align:center; color:red; font-weight:bold; border: 1px solid #cbd5e1; border-top: none;">Database Connection Failed</div>`;
            }
        }

        function formatSafeWeight(val) {
            let w = parseFloat(val);
            if(isNaN(w)) return "0.00 KG";
            return w.toFixed(2) + " KG";
        }

        function renderDashboard() {
            const list = document.getElementById('batch_list');
            if(rawData.length === 0) {
                list.innerHTML = `<div style="background:white; padding:40px; text-align:center; color:#64748b; font-weight:bold; border: 1px solid #cbd5e1; border-top: none;">No batches recorded yet.</div>`;
                return;
            }

            let html = '';
            rawData.forEach((b, index) => {
                let dateStr = new Date(b.created_at).toLocaleString('en-GB', { day:'2-digit', month:'2-digit', year:'2-digit', hour:'2-digit', minute:'2-digit' });
                
                let scanHTML = '';
                if(b.scans && b.scans.length > 0) {
                    scanHTML = b.scans.map(s => {
                        let name = s.ingredient_name || "Unknown RM";
                        return `
                        <div class="scan-pill">
                            <span>${name}</span>
                            <div style="color:var(--navy-command);">${s.rm_tag}</div>
                            <div class="wgt">${formatSafeWeight(s.weight)}</div>
                        </div>`;
                    }).join('');
                } else {
                    scanHTML = `<div style="color:#94a3b8; font-size:13px; font-weight:bold;">No materials scanned yet.</div>`;
                }

                html += `
                <div class="batch-row" onclick="toggleDrawer(${index})">
                    <div class="b-code">${b.batch_code}</div>
                    <div class="b-recipe">${b.fg_code}</div>
                    <div class="b-weight">${formatSafeWeight(b.total_weight)}</div>
                    <div>${b.operator_name || 'System'}</div>
                    <div><span class="b-status ${b.status.toLowerCase()}">${b.status}</span></div>
                    <div class="b-date">${dateStr}</div>
                </div>
                <div class="scan-drawer" id="drawer_${index}">
                    <div class="scan-grid">${scanHTML}</div>
                </div>`;
            });
            list.innerHTML = html;
        }

        function toggleDrawer(index) {
            const drawer = document.getElementById(`drawer_${index}`);
            drawer.style.display = drawer.style.display === 'block' ? 'none' : 'block';
        }

        function exportToExcel() {
            if(rawData.length === 0) return alert("No data to export!");
            
            let exportData = [];
            rawData.forEach(b => {
                if(b.scans && b.scans.length > 0) {
                    b.scans.forEach(s => {
                        exportData.push({
                            "Batch Code": b.batch_code,
                            "Recipe": b.fg_code,
                            "Batch Operator": b.operator_name,
                            "Batch Status": b.status,
                            "Batch Started": new Date(b.created_at).toLocaleString(),
                            "Total Batch Weight (KG)": parseFloat(b.total_weight) || 0,
                            "Scanned RM Tag": s.rm_tag,
                            "RM Name": s.ingredient_name || s.product_code,
                            "RM Weight Issued (KG)": parseFloat(s.weight) || 0,
                            "RM Sub-Assembly Origins": s.parent_tags || "Direct Sourced"
                        });
                    });
                } else {
                    exportData.push({
                        "Batch Code": b.batch_code,
                        "Recipe": b.fg_code,
                        "Batch Operator": b.operator_name,
                        "Batch Status": b.status,
                        "Batch Started": new Date(b.created_at).toLocaleString(),
                        "Total Batch Weight (KG)": parseFloat(b.total_weight) || 0,
                        "Scanned RM Tag": "NONE",
                        "RM Name": "NONE",
                        "RM Weight Issued (KG)": 0,
                        "RM Sub-Assembly Origins": "NONE"
                    });
                }
            });

            const ws = XLSX.utils.json_to_sheet(exportData);
            const wb = XLSX.utils.book_new();
            XLSX.utils.book_append_sheet(wb, ws, "FSSAI_Traceability");
            XLSX.writeFile(wb, `Kilrr_Traceability_${new Date().toISOString().slice(0,10)}.xlsx`);
        }
    </script>
</body>
</html>
