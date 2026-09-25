// ═══════════════════════════════════════════════════════════════
// MANYONI RIDGE WHATSAPP BOT SERVER
// ═══════════════════════════════════════════════════════════════

const http    = require('http');
const express = require('express');
const app     = express();

app.use(express.json());
app.use(express.urlencoded({ extended: true }));

// ── Env vars ──────────────────────────────────────────────────
const WA_TOKEN     = process.env.WHATSAPP_TOKEN     || '';
const WA_PHONE_ID  = process.env.WHATSAPP_PHONE_ID  || '';
const VERIFY_TOKEN = process.env.WHATSAPP_VERIFY_TOKEN || 'manyoni_ridge_2026';
const SB_URL       = process.env.SUPABASE_URL        || '';
const SB_KEY       = process.env.SUPABASE_KEY        || '';
// Railway sets PORT automatically — must use process.env.PORT
const PORT         = process.env.PORT || 3000;

console.log('Starting Manyoni Ridge Bot...');
console.log('Port:', PORT);
console.log('Phone ID:', WA_PHONE_ID || 'NOT SET');
console.log('Supabase URL:', SB_URL || 'NOT SET');

// ── Supabase helpers ──────────────────────────────────────────
const sbHeaders = () => ({
  'apikey':        SB_KEY,
  'Authorization': `Bearer ${SB_KEY}`,
  'Content-Type':  'application/json',
  'Prefer':        'return=representation'
});

async function sbGet(path) {
  const r = await fetch(`${SB_URL}/rest/v1/${path}`, {
    headers: { 'apikey': SB_KEY, 'Authorization': `Bearer ${SB_KEY}` }
  });
  if (!r.ok) { const t = await r.text(); throw new Error(t); }
  return r.json();
}

async function sbPost(table, data) {
  const r = await fetch(`${SB_URL}/rest/v1/${table}`, {
    method:  'POST',
    headers: sbHeaders(),
    body:    JSON.stringify(data)
  });
  if (!r.ok) { const t = await r.text(); throw new Error(t); }
  return r.json();
}

async function sbPatch(path, data) {
  const r = await fetch(`${SB_URL}/rest/v1/${path}`, {
    method:  'PATCH',
    headers: sbHeaders(),
    body:    JSON.stringify(data)
  });
  if (!r.ok) { const t = await r.text(); throw new Error(t); }
  return r.json();
}

// ── Session store ─────────────────────────────────────────────
const sessions = new Map();

function getSession(phone) {
  if (!sessions.has(phone)) resetSession(phone);
  return sessions.get(phone);
}

function resetSession(phone) {
  sessions.set(phone, { flow: null, step: 0, data: {}, staffId: null, staffName: null });
}

// ── Send WhatsApp message ─────────────────────────────────────
async function send(to, text) {
  try {
    console.log(`Sending to ${to}: ${text.slice(0,40)}...`);
    const r = await fetch(`https://graph.facebook.com/v19.0/${WA_PHONE_ID}/messages`, {
      method:  'POST',
      headers: { 'Authorization': `Bearer ${WA_TOKEN}`, 'Content-Type': 'application/json' },
      body:    JSON.stringify({
        messaging_product: 'whatsapp',
        to,
        type: 'text',
        text: { body: text }
      })
    });
    const d = await r.json();
    if (!r.ok) {
      console.error('Send error:', JSON.stringify(d));
    } else {
      console.log('Send success — message ID:', d.messages?.[0]?.id);
    }
    return d;
  } catch(e) {
    console.error('Send failed:', e.message);
  }
}

// ── Auth ──────────────────────────────────────────────────────
async function getStaff(phone) {
  try {
    const digits = phone.replace(/\D/g, '');
    // Search by last 9 digits — matches regardless of +27, 27, or 0 prefix
    const last9 = digits.slice(-9);
    console.log(`Auth lookup: ${phone} → searching last 9 digits: ${last9}`);
    const rows = await sbGet(`staff?phone=ilike.*${last9}&is_active=eq.true&limit=1`);
    if (rows && rows.length > 0) {
      console.log(`Auth: found ${rows[0].name}`);
      return rows[0];
    }
    console.log(`Auth: no staff found for ${phone}`);
    return null;
  } catch(e) { console.error('Auth error:', e.message); return null; }
}

// ── Main menu ─────────────────────────────────────────────────
function mainMenu(name) {
  return `Hi ${name}! 🌿 *Manyoni Ridge*

Reply with a number:

1️⃣  Log Fuel
2️⃣  Update Task
3️⃣  Log Chemical Use
4️⃣  Issue Stock
5️⃣  Animal Sighting
6️⃣  Bird Sighting
7️⃣  Map / Field Point
🆘  SOS Emergency

Type *menu* anytime to restart.`;
}

// ── FUEL FLOW ─────────────────────────────────────────────────
async function handleFuel(phone, msg, session) {
  const d = session.data;

  if (session.step === 0) {
    try {
      const assets = await sbGet('assets?order=asset_name.asc');
      const fuellable = assets.filter(a =>
        ['4x4 / Game Viewer','Bakkie / LDV','Generator','Tractor',
         'TLB / Loader','Golf Cart','Quad bike / ATV','Water Pump'].includes(a.asset_type)
        || a.category === 'high_value'
      );
      if (!fuellable.length) {
        await send(phone, '⚠ No vehicles found in the system. Add them in the dashboard first.');
        resetSession(phone); return;
      }
      d.assets = fuellable;
      let list = '*Which vehicle?*\n\n';
      fuellable.forEach((a, i) => {
        const unit = ['Generator','Tractor','TLB / Loader','Water Pump'].includes(a.asset_type) ? 'hrs' : 'km';
        list += `${i+1}. ${a.asset_name} — ${Number(a.current_reading||0).toLocaleString()} ${unit}\n`;
      });
      await send(phone, list);
      session.step = 1;
    } catch(e) { console.error(e); await send(phone, '⚠ Error loading vehicles. Try again.'); resetSession(phone); }
    return;
  }

  if (session.step === 1) {
    const idx = parseInt(msg) - 1;
    if (isNaN(idx) || idx < 0 || idx >= d.assets.length) {
      await send(phone, `Please reply with a number 1–${d.assets.length}`); return;
    }
    d.asset = d.assets[idx];
    d.isHrs = ['Generator','Tractor','TLB / Loader','Water Pump'].includes(d.asset.asset_type);
    d.unit  = d.isHrs ? 'hrs' : 'km';
    const label = d.isHrs ? 'hour reading' : 'odometer';
    await send(phone, `*${d.asset.asset_name}*\nLast recorded: ${Number(d.asset.current_reading||0).toLocaleString()} ${d.unit}\n\nWhat is the *${label} START* reading?\n(Before fuelling)`);
    session.step = 2;
    return;
  }

  if (session.step === 2) {
    const val = parseFloat(msg.replace(/[^0-9.]/g,''));
    if (isNaN(val) || val <= 0) { await send(phone, 'Please enter a valid number'); return; }
    d.meterStart = val;
    const label = d.isHrs ? 'hour reading' : 'odometer';
    await send(phone, `START: *${val} ${d.unit}* ✓\n\nNow the *${label} END* reading:\n(After fuelling)`);
    session.step = 3;
    return;
  }

  if (session.step === 3) {
    const val = parseFloat(msg.replace(/[^0-9.]/g,''));
    if (isNaN(val) || val <= 0) { await send(phone, 'Please enter a valid number'); return; }
    if (val <= d.meterStart) { await send(phone, `⚠ End (${val}) must be greater than start (${d.meterStart}). Try again.`); return; }
    d.meterEnd = val;
    await send(phone, 'How many *litres* were added?');
    session.step = 4;
    return;
  }

  if (session.step === 4) {
    const val = parseFloat(msg.replace(/[^0-9.]/g,''));
    if (isNaN(val) || val <= 0 || val > 1000) { await send(phone, 'Please enter litres (e.g. 45)'); return; }
    d.litres = val;
    try {
      const areas = await sbGet('fuel_areas?order=name.asc');
      if (!areas.length) {
        d.fuelArea = null;
        await send(phone, '*Who was this issued to?*\n(Type name or "operations")');
        session.step = 6; return;
      }
      d.fuelAreas = areas;
      let list = '*From which tank?*\n\n';
      areas.forEach((a,i) => list += `${i+1}. ${a.name} — ${Number(a.current_litres||0).toFixed(0)}L\n`);
      await send(phone, list);
      session.step = 5;
    } catch(e) {
      d.fuelArea = null;
      await send(phone, '*Who was this issued to?*\n(Type name or "operations")');
      session.step = 6;
    }
    return;
  }

  if (session.step === 5) {
    const idx = parseInt(msg) - 1;
    if (isNaN(idx) || idx < 0 || idx >= d.fuelAreas.length) {
      await send(phone, `Please reply with a number 1–${d.fuelAreas.length}`); return;
    }
    d.fuelArea = d.fuelAreas[idx];
    if (d.litres > Number(d.fuelArea.current_litres)) {
      await send(phone, `⚠ Only ${Number(d.fuelArea.current_litres).toFixed(0)}L in ${d.fuelArea.name}.\n\nHow many litres?`);
      session.step = 4; return;
    }
    await send(phone, '*Who was this issued to?*\n(Type name or "operations")');
    session.step = 6;
    return;
  }

  if (session.step === 6) {
    d.issuedTo = msg.trim();
    const delta = d.meterEnd - d.meterStart;
    const rate  = (d.litres / delta).toFixed(3);
    const flag  = Number(rate) > 0.18 ? '⚠ HIGH' : Number(rate) < 0.03 ? '⚠ LOW' : '✓ Normal';
    await send(phone, `*Confirm:*

🚗 ${d.asset.asset_name}
⛽ ${d.litres}L
📊 ${d.meterStart} → ${d.meterEnd} (${delta} ${d.unit})
📈 ${rate} L/${d.unit} ${flag}
🛢 ${d.fuelArea ? d.fuelArea.name : 'Unspecified'}
👤 ${d.issuedTo}

Reply *YES* to save or *NO* to cancel.`);
    session.step = 7;
    return;
  }

  if (session.step === 7) {
    if (!['yes','y'].includes(msg.toLowerCase())) {
      await send(phone, 'Cancelled. Type *menu* to start again.'); resetSession(phone); return;
    }
    try {
      const delta = d.meterEnd - d.meterStart;
      const rate  = d.litres / delta;
      const flag  = rate > 0.18 ? 'high' : rate < 0.03 ? 'low' : 'ok';
      await sbPost('fuel_logs', {
        asset_id: d.asset.id, asset_name: d.asset.asset_name,
        fuel_area_id: d.fuelArea?.id || null, fuel_area_name: d.fuelArea?.name || null,
        meter_unit: d.unit, meter_start: d.meterStart, meter_end: d.meterEnd,
        litres: d.litres, issued_to_type: 'staff', issued_to_name: d.issuedTo,
        anomaly_flag: flag, logged_by: session.staffName,
        log_date: new Date().toISOString().slice(0,10), source: 'whatsapp'
      });
      await sbPatch(`assets?id=eq.${d.asset.id}`, { current_reading: d.meterEnd });
      if (d.fuelArea) {
        await sbPatch(`fuel_areas?id=eq.${d.fuelArea.id}`, {
          current_litres: Math.max(0, Number(d.fuelArea.current_litres) - d.litres)
        });
      }
      let reply = `✅ *Fuel logged*\n${d.litres}L → ${d.asset.asset_name}`;
      if (flag !== 'ok') reply += `\n\n⚠ *${flag.toUpperCase()} consumption* — management notified.`;
      await send(phone, reply);
      resetSession(phone);
    } catch(e) {
      console.error('Fuel save error:', e.message);
      await send(phone, '⚠ Error saving. Try again.'); resetSession(phone);
    }
    return;
  }
}

// ── STOCK FLOW ────────────────────────────────────────────────
async function handleStock(phone, msg, session) {
  const d = session.data;

  if (session.step === 0) {
    await send(phone, '📦 *Issue Stock*\n\nWhat item are you taking?\n(Type the item name)');
    session.step = 1; return;
  }
  if (session.step === 1) {
    try {
      const items = await sbGet(`stock_items?stock_name=ilike.*${encodeURIComponent(msg.trim())}*&limit=5`);
      if (!items?.length) { await send(phone, `No item found matching "${msg}".\n\nType *menu* to start again.`); resetSession(phone); return; }
      d.items = items;
      if (items.length === 1) {
        d.item = items[0];
        await send(phone, `Found: *${d.item.stock_name}*\n(${d.item.stock_level||0} ${d.item.unit} in stock)\n\nHow many ${d.item.unit}?`);
        session.step = 3; return;
      }
      let list = `Which item?\n\n`;
      items.forEach((it,i) => list += `${i+1}. ${it.stock_name} (${it.stock_level||0} ${it.unit})\n`);
      await send(phone, list);
      session.step = 2;
    } catch(e) { await send(phone, '⚠ Error. Try again.'); resetSession(phone); }
    return;
  }
  if (session.step === 2) {
    const idx = parseInt(msg) - 1;
    if (isNaN(idx) || idx < 0 || idx >= d.items.length) { await send(phone, `Reply 1–${d.items.length}`); return; }
    d.item = d.items[idx];
    await send(phone, `*${d.item.stock_name}*\n${d.item.stock_level||0} ${d.item.unit} in stock\n\nHow many ${d.item.unit}?`);
    session.step = 3; return;
  }
  if (session.step === 3) {
    const qty = parseFloat(msg.replace(/[^0-9.]/g,''));
    if (isNaN(qty) || qty <= 0) { await send(phone, 'Enter a valid quantity'); return; }
    if (qty > Number(d.item.stock_level||0)) { await send(phone, `⚠ Only ${d.item.stock_level} ${d.item.unit} available.`); return; }
    d.qty = qty;
    await send(phone, 'Task or reason for taking this item?');
    session.step = 4; return;
  }
  if (session.step === 4) {
    d.reason = msg.trim();
    await send(phone, `*Confirm:*\n📦 ${d.item.stock_name} x${d.qty} ${d.item.unit}\n👤 ${session.staffName}\n📋 ${d.reason}\n\nReply *YES* to save.`);
    session.step = 5; return;
  }
  if (session.step === 5) {
    if (!['yes','y'].includes(msg.toLowerCase())) { await send(phone, 'Cancelled.'); resetSession(phone); return; }
    try {
      await sbPost('stock_movements', {
        stock_item_id: d.item.id, stock_name: d.item.stock_name,
        movement_type: 'out', quantity: d.qty, unit: d.item.unit,
        reason: d.reason, issued_to: session.staffName,
        unit_cost: d.item.current_unit_cost||0,
        total_cost: d.qty * Number(d.item.current_unit_cost||0),
        movement_date: new Date().toISOString().slice(0,10), source: 'whatsapp'
      });
      await sbPatch(`stock_items?id=eq.${d.item.id}`, { stock_level: Math.max(0, Number(d.item.stock_level||0) - d.qty) });
      await send(phone, `✅ *Stock issued*\n${d.qty} ${d.item.unit} ${d.item.stock_name}`);
      resetSession(phone);
    } catch(e) { await send(phone, '⚠ Error saving. Try again.'); resetSession(phone); }
    return;
  }
}

// ── TASK FLOW ─────────────────────────────────────────────────
async function handleTask(phone, msg, session) {
  const d = session.data;

  if (session.step === 0) {
    await send(phone, '✅ *Task Update*\n\nType part of the task name:');
    session.step = 1; return;
  }
  if (session.step === 1) {
    try {
      const tasks = await sbGet(`tasks?title=ilike.*${encodeURIComponent(msg.trim())}*&status=neq.closed&limit=5`);
      if (!tasks?.length) { await send(phone, `No open task found matching "${msg}". Try again.`); return; }
      d.tasks = tasks;
      if (tasks.length === 1) {
        d.task = tasks[0];
        await send(phone, `*${d.task.title}*\nStatus: ${d.task.status}\n\n1. Started\n2. Completed\n3. Blocked\n4. Add note`);
        session.step = 3; return;
      }
      let list = 'Which task?\n\n';
      tasks.forEach((t,i) => list += `${i+1}. ${t.title} (${t.status})\n`);
      await send(phone, list);
      session.step = 2;
    } catch(e) { await send(phone, '⚠ Error. Try again.'); resetSession(phone); }
    return;
  }
  if (session.step === 2) {
    const idx = parseInt(msg) - 1;
    if (isNaN(idx) || idx < 0 || idx >= d.tasks.length) { await send(phone, `Reply 1–${d.tasks.length}`); return; }
    d.task = d.tasks[idx];
    await send(phone, `*${d.task.title}*\n\n1. Started\n2. Completed\n3. Blocked\n4. Add note`);
    session.step = 3; return;
  }
  if (session.step === 3) {
    const MAP = {'1':'in_progress','2':'completed','3':'blocked','4':null};
    d.newStatus = MAP[msg.trim()];
    if (d.newStatus === undefined) { await send(phone, 'Reply 1, 2, 3, or 4'); return; }
    await send(phone, 'Any notes? (or reply "done" to skip)');
    session.step = 4; return;
  }
  if (session.step === 4) {
    d.note = msg.toLowerCase() === 'done' ? null : msg.trim();
    try {
      const upd = { updated_at: new Date().toISOString() };
      if (d.newStatus) upd.status = d.newStatus;
      if (d.newStatus === 'in_progress') upd.started_at = new Date().toISOString();
      if (d.newStatus === 'completed')   upd.completed_at = new Date().toISOString();
      await sbPatch(`tasks?id=eq.${d.task.id}`, upd);
      if (d.note) await sbPost('task_logs', { task_id: d.task.id, note: d.note, logged_by: session.staffName, log_date: new Date().toISOString().slice(0,10), source: 'whatsapp' });
      const labels = { in_progress:'▶ Started', completed:'✅ Completed', blocked:'⚠ Blocked', null:'📝 Note added' };
      await send(phone, `✅ *Task updated*\n${d.task.title}\n${labels[d.newStatus]||'📝 Note added'}${d.note?'\n\n📝 '+d.note:''}`);
      resetSession(phone);
    } catch(e) { await send(phone, '⚠ Error saving.'); resetSession(phone); }
    return;
  }
}

// ── ANIMAL SIGHTING ───────────────────────────────────────────
async function handleAnimal(phone, msg, session) {
  const d = session.data;
  if (session.step === 0) { await send(phone, '🦁 Species?'); session.step = 1; return; }
  if (session.step === 1) { d.species = msg.trim(); await send(phone, `How many ${d.species}?`); session.step = 2; return; }
  if (session.step === 2) {
    d.count = msg.trim();
    await send(phone, '1. Grazing/Feeding\n2. Moving\n3. Drinking\n4. Resting\n5. Alert/Stressed\n6. Other');
    session.step = 3; return;
  }
  if (session.step === 3) {
    const B = {'1':'Grazing/Feeding','2':'Moving','3':'Drinking','4':'Resting','5':'Alert/Stressed','6':'Other'};
    d.behaviour = B[msg.trim()] || msg.trim();
    await send(phone, 'Location? (type name or share GPS 📍)');
    session.step = 4; return;
  }
  if (session.step === 4) {
    try {
      await sbPost('environment_observations', { observation_type:'mammal', species:d.species, count:parseInt(d.count)||1, behaviour:d.behaviour, location_text:msg.trim(), recorded_by:session.staffName, observed_at:new Date().toISOString(), source:'whatsapp' });
      await send(phone, `✅ Sighting logged\n🦁 ${d.count}x ${d.species} — ${d.behaviour}\n📍 ${msg.trim()}`);
      resetSession(phone);
    } catch(e) { await send(phone, '⚠ Error saving.'); resetSession(phone); }
    return;
  }
}

// ── BIRD SIGHTING ─────────────────────────────────────────────
async function handleBird(phone, msg, session) {
  const d = session.data;
  if (session.step === 0) { await send(phone, '🦅 Bird species?'); session.step = 1; return; }
  if (session.step === 1) { d.species = msg.trim(); await send(phone, `How many ${d.species}?`); session.step = 2; return; }
  if (session.step === 2) { d.count = msg.trim(); await send(phone, 'Location?'); session.step = 3; return; }
  if (session.step === 3) {
    try {
      await sbPost('environment_observations', { observation_type:'bird', species:d.species, count:parseInt(d.count)||1, location_text:msg.trim(), recorded_by:session.staffName, observed_at:new Date().toISOString(), source:'whatsapp' });
      await send(phone, `✅ Bird sighting logged\n🦅 ${d.count}x ${d.species}\n📍 ${msg.trim()}`);
      resetSession(phone);
    } catch(e) { await send(phone, '⚠ Error saving.'); resetSession(phone); }
    return;
  }
}

// ── MAP POINT ─────────────────────────────────────────────────
async function handleMapPoint(phone, msg, session) {
  const d = session.data;
  if (session.step === 0) {
    await send(phone, '📍 What did you find?\n1. Invasive plant\n2. Erosion\n3. Fence damage\n4. Road issue\n5. Water issue\n6. Other');
    session.step = 1; return;
  }
  if (session.step === 1) {
    const T = {'1':'invasive_plant','2':'erosion','3':'fence_damage','4':'road_issue','5':'water_issue','6':'other'};
    d.type = T[msg.trim()] || 'other';
    await send(phone, 'Describe what you found:');
    session.step = 2; return;
  }
  if (session.step === 2) {
    d.desc = msg.trim();
    await send(phone, 'Priority?\n1. Low\n2. Medium\n3. High');
    session.step = 3; return;
  }
  if (session.step === 3) {
    const P = {'1':'low','2':'medium','3':'high'};
    d.priority = P[msg.trim()] || 'medium';
    await send(phone, 'Location? (type name or share GPS 📍)');
    session.step = 4; return;
  }
  if (session.step === 4) {
    try {
      await sbPost('environment_observations', { observation_type:'map_point', observation_subtype:d.type, description:d.desc, priority:d.priority, location_text:msg.trim(), recorded_by:session.staffName, observed_at:new Date().toISOString(), source:'whatsapp' });
      await send(phone, `✅ Field point logged\n📍 ${d.type.replace(/_/g,' ')} (${d.priority})\n📝 ${d.desc}\n🗺 ${msg.trim()}`);
      resetSession(phone);
    } catch(e) { await send(phone, '⚠ Error saving.'); resetSession(phone); }
    return;
  }
}

// ── CHEMICAL USE ──────────────────────────────────────────────
async function handleChem(phone, msg, session) {
  const d = session.data;
  if (session.step === 0) { await send(phone, '⚗️ Chemical name?'); session.step = 1; return; }
  if (session.step === 1) {
    try {
      const chems = await sbGet(`chemicals?name=ilike.*${encodeURIComponent(msg.trim())}*&limit=3`);
      if (!chems?.length) { await send(phone, `Chemical "${msg}" not found. Check name.`); resetSession(phone); return; }
      d.chem = chems[0];
      await send(phone, `*${d.chem.name}*\n\n⚠️ PPE REQUIRED: ${d.chem.ppe_required||'Gloves'}\n\nPut on PPE then type *CONFIRMED*`);
      session.step = 2;
    } catch(e) { await send(phone, '⚠ Error.'); resetSession(phone); }
    return;
  }
  if (session.step === 2) {
    if (msg.trim().toUpperCase() !== 'CONFIRMED') { await send(phone, '⛔ Type *CONFIRMED* to confirm PPE is on. Required for compliance.'); return; }
    await send(phone, '✓ PPE confirmed.\n\nQuantity used? (e.g. "2 litres")');
    session.step = 3; return;
  }
  if (session.step === 3) { d.qty = msg.trim(); await send(phone, 'Area or species treated?'); session.step = 4; return; }
  if (session.step === 4) {
    try {
      await sbPost('chemical_usage', { chemical_id:d.chem.id, chemical_name:d.chem.name, quantity_used:d.qty, target:msg.trim(), ppe_confirmed:true, applied_by:session.staffName, application_date:new Date().toISOString(), source:'whatsapp' });
      await send(phone, `✅ Chemical use logged\n⚗️ ${d.chem.name} — ${d.qty}\n🎯 ${msg.trim()}\n🦺 PPE: ✓`);
      resetSession(phone);
    } catch(e) { await send(phone, '⚠ Error saving.'); resetSession(phone); }
    return;
  }
}

// ── EMERGENCY ─────────────────────────────────────────────────
async function handleSOS(phone, session) {
  try {
    await sbPost('tasks', { title:`🚨 EMERGENCY — ${session.staffName}`, description:`Emergency via WhatsApp from ${session.staffName} (${phone})`, priority:'critical', status:'created', type:'incident', source:'whatsapp' });
    const mgmt = await sbGet('staff?department=eq.Management&is_active=eq.true');
    for (const m of mgmt) {
      if (m.phone && m.phone !== phone) {
        await send(m.phone, `🚨 *EMERGENCY*\nFrom: *${session.staffName}*\nTime: ${new Date().toLocaleTimeString('en-ZA')}\nContact: ${phone}`);
      }
    }
    await send(phone, `🚨 *ALERT SENT*\n\nManagement notified. Stay where you are.\n\nLife-threatening? Call *112*`);
    resetSession(phone);
  } catch(e) {
    await send(phone, '🚨 Error sending alert. Call management directly or dial *112*');
    resetSession(phone);
  }
}

// ── MESSAGE ROUTER ────────────────────────────────────────────
async function handleMessage(phone, msg) {
  const session = getSession(phone);
  const text    = msg.trim().toLowerCase();

  // SOS — always works
  if (text === 'sos' || text === 'emergency') {
    const staff = await getStaff(phone);
    if (staff) { session.staffName = staff.preferred_name || staff.name; }
    else { session.staffName = 'Unknown'; }
    await handleSOS(phone, session);
    return;
  }

  // Reset commands
  if (['menu','start','hi','hello','hie','sawubona'].includes(text)) {
    resetSession(phone);
    const s2 = getSession(phone);
    const staff = await getStaff(phone);
    if (!staff) { await send(phone, `⛔ Number not registered.\n\nContact your manager to be added to the system.`); return; }
    s2.staffId   = staff.id;
    s2.staffName = staff.preferred_name || staff.name;
    await send(phone, mainMenu(s2.staffName));
    return;
  }

  if (['cancel','stop','khansela'].includes(text)) {
    resetSession(phone); await send(phone, 'Cancelled ✓\n\nType *menu* to start again.'); return;
  }

  // Start new flow if no active session
  if (!session.flow) {
    const staff = await getStaff(phone);
    if (!staff) { await send(phone, `⛔ Your number is not registered.\n\nContact your manager.`); return; }
    session.staffId   = staff.id;
    session.staffName = staff.preferred_name || staff.name;

    const FLOWS = {
      '1':'fuel','fuel':'fuel','diesel':'fuel','petrol':'fuel',
      '2':'task','task':'task',
      '3':'chem','chemical':'chem','chem':'chem',
      '4':'stock','stock':'stock',
      '5':'animal','animal':'animal','sighting':'animal',
      '6':'bird','bird':'bird',
      '7':'map','map':'map','point':'map',
    };
    const flow = FLOWS[text];
    if (!flow) { await send(phone, mainMenu(session.staffName)); return; }
    session.flow = flow;
    session.step = 0;
  }

  // Route to flow
  try {
    switch(session.flow) {
      case 'fuel':   await handleFuel(phone, msg, session);     break;
      case 'stock':  await handleStock(phone, msg, session);    break;
      case 'task':   await handleTask(phone, msg, session);     break;
      case 'animal': await handleAnimal(phone, msg, session);   break;
      case 'bird':   await handleBird(phone, msg, session);     break;
      case 'map':    await handleMapPoint(phone, msg, session); break;
      case 'chem':   await handleChem(phone, msg, session);     break;
      default: resetSession(phone); await send(phone, mainMenu(session.staffName||'there'));
    }
  } catch(e) {
    console.error('Flow error:', e.message, e.stack);
    await send(phone, '⚠ Something went wrong. Type *menu* to start again.');
    resetSession(phone);
  }
}

// ══════════════════════════════════════════════════════════════
// ROUTES
// ══════════════════════════════════════════════════════════════

// CRITICAL — Meta webhook verification
app.get('/webhook', (req, res) => {
  console.log('Webhook verification request received');
  console.log('Query:', req.query);
  const mode      = req.query['hub.mode'];
  const token     = req.query['hub.verify_token'];
  const challenge = req.query['hub.challenge'];
  console.log(`Mode: ${mode}, Token match: ${token === VERIFY_TOKEN}`);
  if (mode === 'subscribe' && token === VERIFY_TOKEN) {
    console.log('✓ Webhook verified');
    res.status(200).send(challenge);
  } else {
    console.error('✗ Webhook verification failed — token mismatch');
    console.error('Expected:', VERIFY_TOKEN, 'Got:', token);
    res.sendStatus(403);
  }
});

// Incoming messages from Meta
app.post('/webhook', async (req, res) => {
  res.sendStatus(200); // Always respond immediately
  try {
    const message = req.body?.entry?.[0]?.changes?.[0]?.value?.messages?.[0];
    if (!message) return;
    const phone = message.from;
    let text = '';
    if      (message.type === 'text')     text = message.text?.body || '';
    else if (message.type === 'location') text = `GPS:${message.location.latitude},${message.location.longitude}`;
    else if (message.type === 'image')    text = '[photo]';
    else { await send(phone, 'Please send a text message. Type *menu* for options.'); return; }
    console.log(`[${new Date().toISOString()}] MSG from ${phone}: ${text.slice(0,50)}`);
    await handleMessage(phone, text);
  } catch(e) {
    console.error('Webhook handler error:', e.message);
  }
});

// Health check — test this first after deploy
app.get('/health', (req, res) => {
  res.json({ status:'ok', sessions:sessions.size, time:new Date().toISOString() });
});

app.get('/', (req, res) => {
  res.json({ name:'Manyoni Ridge Bot', status:'running', webhook:'/webhook' });
});

// ── Start server ──────────────────────────────────────────────
const server = http.createServer(app);
server.listen(PORT, '0.0.0.0', () => {
  console.log(`✓ Manyoni Ridge Bot listening on 0.0.0.0:${PORT}`);
});

// Handle Railway shutdown gracefully
process.on('SIGTERM', () => { server.close(() => process.exit(0)); });
process.on('SIGINT',  () => { server.close(() => process.exit(0)); });
