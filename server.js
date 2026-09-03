// ═══════════════════════════════════════════════════════════════
// MANYONI RIDGE WHATSAPP BOT SERVER
// Node.js / Express — deploys to Railway.app
// Connects to Supabase — same DB as the web dashboard
// ═══════════════════════════════════════════════════════════════

const express = require('express');
const app = express();
app.use(express.json());

// ── Environment Variables ──────────────────────────────────────
const WA_TOKEN        = process.env.WHATSAPP_TOKEN;
const WA_PHONE_ID     = process.env.WHATSAPP_PHONE_ID;
const VERIFY_TOKEN    = process.env.WHATSAPP_VERIFY_TOKEN || 'manyoni_ridge_2026';
const SUPABASE_URL    = process.env.SUPABASE_URL;
const SUPABASE_KEY    = process.env.SUPABASE_KEY;
const PORT            = process.env.PORT || 3000;

// ── Supabase client (no SDK needed — raw fetch) ───────────────
const sb = {
  get: async (path) => {
    const r = await fetch(`${SUPABASE_URL}/rest/v1/${path}`, {
      headers: { 'apikey': SUPABASE_KEY, 'Authorization': `Bearer ${SUPABASE_KEY}` }
    });
    if (!r.ok) throw new Error(await r.text());
    return r.json();
  },
  post: async (table, data) => {
    const r = await fetch(`${SUPABASE_URL}/rest/v1/${table}`, {
      method: 'POST',
      headers: {
        'apikey': SUPABASE_KEY, 'Authorization': `Bearer ${SUPABASE_KEY}`,
        'Content-Type': 'application/json', 'Prefer': 'return=representation'
      },
      body: JSON.stringify(data)
    });
    if (!r.ok) throw new Error(await r.text());
    return r.json();
  },
  patch: async (path, data) => {
    const r = await fetch(`${SUPABASE_URL}/rest/v1/${path}`, {
      method: 'PATCH',
      headers: {
        'apikey': SUPABASE_KEY, 'Authorization': `Bearer ${SUPABASE_KEY}`,
        'Content-Type': 'application/json', 'Prefer': 'return=representation'
      },
      body: JSON.stringify(data)
    });
    if (!r.ok) throw new Error(await r.text());
    return r.json();
  }
};

// ── Session store (in-memory — resets on server restart) ──────
// In production, swap for Redis
const sessions = new Map();

function getSession(phone) {
  if (!sessions.has(phone)) {
    sessions.set(phone, { flow: null, step: 0, data: {}, lang: 'en' });
  }
  return sessions.get(phone);
}

function clearSession(phone) {
  sessions.set(phone, { flow: null, step: 0, data: {}, lang: 'en' });
}

// ── Send WhatsApp message ─────────────────────────────────────
async function send(to, text) {
  const r = await fetch(`https://graph.facebook.com/v19.0/${WA_PHONE_ID}/messages`, {
    method: 'POST',
    headers: {
      'Authorization': `Bearer ${WA_TOKEN}`,
      'Content-Type': 'application/json'
    },
    body: JSON.stringify({
      messaging_product: 'whatsapp',
      to,
      type: 'text',
      text: { body: text }
    })
  });
  const data = await r.json();
  if (!r.ok) console.error('Send error:', JSON.stringify(data));
  return data;
}

// ── Auth — look up staff by phone number ──────────────────────
async function getStaff(phone) {
  try {
    // Normalise phone — try +27... and 27... and 0...
    const digits = phone.replace(/\D/g, '');
    const variants = [
      '+' + digits,
      digits,
      '0' + digits.slice(2)  // 0821234567
    ];
    for (const v of variants) {
      const rows = await sb.get(`staff?phone=eq.${encodeURIComponent(v)}&limit=1`);
      if (rows && rows.length > 0) return rows[0];
    }
    return null;
  } catch(e) {
    console.error('Auth error:', e.message);
    return null;
  }
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

// ── FLOW: FUEL LOG ────────────────────────────────────────────
async function handleFuel(phone, msg, session) {
  const d = session.data;

  if (session.step === 0) {
    // Load assets
    try {
      const assets = await sb.get(`assets?order=asset_name.asc`);
      const fuellable = assets.filter(a =>
        ['4x4 / Game Viewer','Bakkie / LDV','Generator','Tractor',
         'TLB / Loader','Golf Cart','Quad bike / ATV','Water Pump'].includes(a.asset_type)
        || a.category === 'high_value'
      );
      if (!fuellable.length) { await send(phone, '⚠ No vehicles found. Add them in the dashboard first.'); clearSession(phone); return; }
      d.assets = fuellable;
      let list = '*Which vehicle?*\n\n';
      fuellable.forEach((a, i) => {
        const unit = ['Generator','Tractor','TLB / Loader','Water Pump'].includes(a.asset_type) ? 'hrs' : 'km';
        list += `${i+1}. ${a.asset_name} — ${Number(a.current_reading||0).toLocaleString()} ${unit}\n`;
      });
      await send(phone, list);
      session.step = 1;
    } catch(e) { await send(phone, '⚠ Error loading vehicles. Try again.'); clearSession(phone); }
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
    const last  = Number(d.asset.current_reading || 0);
    await send(phone, `*${d.asset.asset_name}*\nLast recorded: ${last.toLocaleString()} ${d.unit}\n\nWhat is the *${label} START* reading?\n(Before fuelling)`);
    session.step = 2;
    return;
  }

  if (session.step === 2) {
    const val = parseFloat(msg.replace(/[^0-9.]/g, ''));
    if (isNaN(val) || val <= 0) { await send(phone, 'Please enter a valid number'); return; }
    d.meterStart = val;
    const label = d.isHrs ? 'hour reading' : 'odometer';
    await send(phone, `${label.charAt(0).toUpperCase()+label.slice(1)} START: *${val} ${d.unit}* ✓\n\nNow enter the *${label} END* reading:\n(After fuelling)`);
    session.step = 3;
    return;
  }

  if (session.step === 3) {
    const val = parseFloat(msg.replace(/[^0-9.]/g, ''));
    if (isNaN(val) || val <= 0) { await send(phone, 'Please enter a valid number'); return; }
    if (val <= d.meterStart) { await send(phone, `⚠ End reading (${val}) must be greater than start (${d.meterStart}). Try again.`); return; }
    d.meterEnd = val;
    await send(phone, `How many *litres* were added?`);
    session.step = 4;
    return;
  }

  if (session.step === 4) {
    const val = parseFloat(msg.replace(/[^0-9.]/g, ''));
    if (isNaN(val) || val <= 0 || val > 1000) { await send(phone, 'Please enter litres (e.g. 45)'); return; }
    d.litres = val;
    // Load fuel areas
    try {
      const areas = await sb.get('fuel_areas?order=name.asc');
      if (!areas.length) {
        d.fuelArea = null;
        await send(phone, '*Who was this issued to?*\n(Type staff name or "operations")');
        session.step = 6;
        return;
      }
      d.fuelAreas = areas;
      let list = '*From which tank / fuel store?*\n\n';
      areas.forEach((a, i) => {
        const avail = Number(a.current_litres || 0).toFixed(0);
        list += `${i+1}. ${a.name} — ${avail}L available\n`;
      });
      await send(phone, list);
      session.step = 5;
    } catch(e) {
      d.fuelArea = null;
      await send(phone, '*Who was this issued to?*\n(Type staff name or "operations")');
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
      await send(phone, `⚠ Only ${Number(d.fuelArea.current_litres).toFixed(0)}L available in ${d.fuelArea.name}. Check the amount and try again.\n\nHow many *litres* were added?`);
      session.step = 4;
      return;
    }
    await send(phone, '*Who was this issued to?*\n(Type staff name or "guest" or "operations")');
    session.step = 6;
    return;
  }

  if (session.step === 6) {
    d.issuedTo = msg.trim();
    const delta = d.meterEnd - d.meterStart;
    const rate  = (d.litres / delta).toFixed(3);
    const anomaly = Number(rate) > 0.18 || (d.isHrs && Number(rate) > 10) ? '⚠ HIGH consumption' :
                    Number(rate) < 0.03 ? '⚠ LOW consumption' : '✓ Normal';
    const summary = `*Confirm fuel log:*

🚗 Vehicle: ${d.asset.asset_name}
⛽ Litres: ${d.litres}L
📊 ${d.isHrs ? 'Hours' : 'Odometer'}: ${d.meterStart} → ${d.meterEnd} (${delta} ${d.unit})
📈 Consumption: ${rate} L/${d.unit} ${anomaly}
🛢 From: ${d.fuelArea ? d.fuelArea.name : 'Not specified'}
👤 Issued to: ${d.issuedTo}

Reply *YES* to confirm or *NO* to cancel.`;
    await send(phone, summary);
    session.step = 7;
    return;
  }

  if (session.step === 7) {
    if (msg.toLowerCase() !== 'yes' && msg.toLowerCase() !== 'y') {
      await send(phone, 'Cancelled. Type *menu* to start again.'); clearSession(phone); return;
    }
    try {
      const delta = d.meterEnd - d.meterStart;
      const rate  = d.litres / delta;
      const flag  = rate > 0.18 || (d.isHrs && rate > 10) ? 'high' : rate < 0.03 ? 'low' : 'ok';
      await sb.post('fuel_logs', {
        asset_id:       d.asset.id,
        asset_name:     d.asset.asset_name,
        fuel_area_id:   d.fuelArea ? d.fuelArea.id : null,
        fuel_area_name: d.fuelArea ? d.fuelArea.name : null,
        meter_unit:     d.unit,
        meter_start:    d.meterStart,
        meter_end:      d.meterEnd,
        litres:         d.litres,
        issued_to_type: 'staff',
        issued_to_name: d.issuedTo,
        anomaly_flag:   flag,
        logged_by:      session.staffName,
        log_date:       new Date().toISOString().slice(0,10),
        source:         'whatsapp'
      });
      await sb.patch(`assets?id=eq.${d.asset.id}`, { current_reading: d.meterEnd });
      if (d.fuelArea) {
        await sb.patch(`fuel_areas?id=eq.${d.fuelArea.id}`, {
          current_litres: Math.max(0, Number(d.fuelArea.current_litres) - d.litres)
        });
      }
      let reply = `✅ *Fuel logged successfully*\n${d.litres}L → ${d.asset.asset_name}`;
      if (flag !== 'ok') reply += `\n\n⚠ *${flag.toUpperCase()} consumption detected* — management notified.`;
      await send(phone, reply);
      clearSession(phone);
    } catch(e) {
      console.error('Fuel save error:', e.message);
      await send(phone, '⚠ Error saving. Please try again or contact management.');
      clearSession(phone);
    }
    return;
  }
}

// ── FLOW: STOCK ISSUE ─────────────────────────────────────────
async function handleStock(phone, msg, session) {
  const d = session.data;

  if (session.step === 0) {
    await send(phone, '*What item are you taking from stores?*\n(Type the item name)');
    session.step = 1;
    return;
  }

  if (session.step === 1) {
    try {
      const search = msg.trim().toLowerCase();
      const items = await sb.get(`stock_items?stock_name=ilike.*${encodeURIComponent(search)}*&limit=5`);
      if (!items || !items.length) {
        await send(phone, `No item found matching "${msg}".\n\nTry a different name or contact management to add the item.`);
        clearSession(phone); return;
      }
      d.items = items;
      if (items.length === 1) {
        d.item = items[0];
        await send(phone, `Found: *${d.item.stock_name}*\n(${d.item.stock_level || 0} ${d.item.unit} in stock)\n\nHow many ${d.item.unit}?`);
        session.step = 3;
        return;
      }
      let list = `Found ${items.length} items — which one?\n\n`;
      items.forEach((it, i) => list += `${i+1}. ${it.stock_name} (${it.stock_level || 0} ${it.unit})\n`);
      await send(phone, list);
      session.step = 2;
    } catch(e) {
      await send(phone, '⚠ Error searching stock. Try again.'); clearSession(phone);
    }
    return;
  }

  if (session.step === 2) {
    const idx = parseInt(msg) - 1;
    if (isNaN(idx) || idx < 0 || idx >= d.items.length) {
      await send(phone, `Please reply with a number 1–${d.items.length}`); return;
    }
    d.item = d.items[idx];
    await send(phone, `*${d.item.stock_name}*\n${d.item.stock_level || 0} ${d.item.unit} in stock\n\nHow many ${d.item.unit}?`);
    session.step = 3;
    return;
  }

  if (session.step === 3) {
    const qty = parseFloat(msg.replace(/[^0-9.]/g, ''));
    if (isNaN(qty) || qty <= 0) { await send(phone, 'Please enter a valid quantity'); return; }
    if (qty > Number(d.item.stock_level || 0)) {
      await send(phone, `⚠ Only ${d.item.stock_level} ${d.item.unit} available. Enter a smaller quantity.`); return;
    }
    d.qty = qty;
    await send(phone, '*What task or reason?*\n(Type task name or reason for taking this item)');
    session.step = 4;
    return;
  }

  if (session.step === 4) {
    d.reason = msg.trim();
    const summary = `*Confirm stock issue:*

📦 Item: ${d.item.stock_name}
🔢 Quantity: ${d.qty} ${d.item.unit}
👤 Issued to: ${session.staffName}
📋 Reason: ${d.reason}

Reply *YES* to confirm or *NO* to cancel.`;
    await send(phone, summary);
    session.step = 5;
    return;
  }

  if (session.step === 5) {
    if (msg.toLowerCase() !== 'yes' && msg.toLowerCase() !== 'y') {
      await send(phone, 'Cancelled. Type *menu* to start again.'); clearSession(phone); return;
    }
    try {
      const newLevel = Math.max(0, Number(d.item.stock_level || 0) - d.qty);
      await sb.post('stock_movements', {
        stock_item_id:   d.item.id,
        stock_name:      d.item.stock_name,
        movement_type:   'out',
        quantity:        d.qty,
        unit:            d.item.unit,
        reason:          d.reason,
        issued_to:       session.staffName,
        unit_cost:       d.item.current_unit_cost || 0,
        total_cost:      (d.qty * Number(d.item.current_unit_cost || 0)),
        movement_date:   new Date().toISOString().slice(0,10),
        source:          'whatsapp'
      });
      await sb.patch(`stock_items?id=eq.${d.item.id}`, { stock_level: newLevel });
      // Log cost entry
      if (Number(d.item.current_unit_cost || 0) > 0) {
        await sb.post('cost_entries', {
          category:    d.item.category || 'stock',
          description: `Stock issued: ${d.item.stock_name} x${d.qty} — ${d.reason}`,
          quantity:    d.qty,
          unit_cost:   Number(d.item.current_unit_cost || 0),
          recorded_by: session.staffName,
          entry_date:  new Date().toISOString().slice(0,10),
          source:      'stock_out'
        });
      }
      const lowWarning = newLevel <= Number(d.item.minimum_level || 0) && d.item.minimum_level
        ? `\n\n⚠ *Low stock alert* — only ${newLevel} ${d.item.unit} remaining (minimum: ${d.item.minimum_level}).` : '';
      await send(phone, `✅ *Stock issued*\n${d.qty} ${d.item.unit} ${d.item.stock_name}${lowWarning}`);
      clearSession(phone);
    } catch(e) {
      console.error('Stock save error:', e.message);
      await send(phone, '⚠ Error saving. Please try again.'); clearSession(phone);
    }
    return;
  }
}

// ── FLOW: TASK UPDATE ─────────────────────────────────────────
async function handleTask(phone, msg, session) {
  const d = session.data;

  if (session.step === 0) {
    await send(phone, '*What task are you updating?*\n(Type part of the task name)');
    session.step = 1;
    return;
  }

  if (session.step === 1) {
    try {
      const search = msg.trim().toLowerCase();
      const tasks = await sb.get(`tasks?title=ilike.*${encodeURIComponent(search)}*&status=neq.closed&status=neq.completed&limit=5`);
      if (!tasks || !tasks.length) {
        await send(phone, `No open task found matching "${msg}".\n\nTry a different name.`); return;
      }
      d.tasks = tasks;
      if (tasks.length === 1) {
        d.task = tasks[0];
        await send(phone, `Found: *${d.task.title}*\nStatus: ${d.task.status}\n\nWhat is the update?\n1. Started\n2. Completed\n3. Blocked / Issue\n4. Add note only`);
        session.step = 3;
        return;
      }
      let list = `Found ${tasks.length} tasks:\n\n`;
      tasks.forEach((t, i) => list += `${i+1}. ${t.title} (${t.status})\n`);
      await send(phone, list);
      session.step = 2;
    } catch(e) { await send(phone, '⚠ Error. Try again.'); clearSession(phone); }
    return;
  }

  if (session.step === 2) {
    const idx = parseInt(msg) - 1;
    if (isNaN(idx) || idx < 0 || idx >= d.tasks.length) {
      await send(phone, `Please reply with a number 1–${d.tasks.length}`); return;
    }
    d.task = d.tasks[idx];
    await send(phone, `*${d.task.title}*\n\nWhat is the update?\n1. Started\n2. Completed\n3. Blocked / Issue\n4. Add note only`);
    session.step = 3;
    return;
  }

  if (session.step === 3) {
    const STATUS_MAP = { '1':'in_progress', '2':'completed', '3':'blocked', '4':null };
    d.newStatus = STATUS_MAP[msg.trim()];
    if (d.newStatus === undefined) { await send(phone, 'Please reply 1, 2, 3, or 4'); return; }
    await send(phone, '*Any notes, materials used, or issues?*\n(Type your note or reply "done" to skip)');
    session.step = 4;
    return;
  }

  if (session.step === 4) {
    d.note = msg.toLowerCase() === 'done' ? null : msg.trim();
    try {
      const update = { updated_at: new Date().toISOString() };
      if (d.newStatus) update.status = d.newStatus;
      if (d.newStatus === 'in_progress') update.started_at = new Date().toISOString();
      if (d.newStatus === 'completed')   update.completed_at = new Date().toISOString();
      await sb.patch(`tasks?id=eq.${d.task.id}`, update);
      if (d.note) {
        await sb.post('task_logs', {
          task_id:    d.task.id,
          note:       d.note,
          logged_by:  session.staffName,
          log_date:   new Date().toISOString().slice(0,10),
          source:     'whatsapp'
        });
      }
      const statusLabel = { in_progress:'Started ▶', completed:'Completed ✅', blocked:'Blocked ⚠', null:'Note added 📝' };
      await send(phone, `✅ *Task updated*\n${d.task.title}\n${statusLabel[d.newStatus] || 'Note added 📝'}${d.note ? '\n\n📝 ' + d.note : ''}`);
      clearSession(phone);
    } catch(e) {
      console.error('Task update error:', e.message);
      await send(phone, '⚠ Error saving. Try again.'); clearSession(phone);
    }
    return;
  }
}

// ── FLOW: ANIMAL SIGHTING ─────────────────────────────────────
async function handleAnimal(phone, msg, session) {
  const d = session.data;

  if (session.step === 0) {
    await send(phone, '🦁 *Animal Sighting*\n\nWhat species did you see?');
    session.step = 1; return;
  }
  if (session.step === 1) {
    d.species = msg.trim();
    await send(phone, `How many *${d.species}*?`);
    session.step = 2; return;
  }
  if (session.step === 2) {
    d.count = msg.trim();
    await send(phone, `What were they doing?\n1. Grazing/Feeding\n2. Moving\n3. Drinking\n4. Resting\n5. Alert/Stressed\n6. Other`);
    session.step = 3; return;
  }
  if (session.step === 3) {
    const BEHAVIOUR = { '1':'Grazing/Feeding','2':'Moving','3':'Drinking','4':'Resting','5':'Alert/Stressed','6':'Other' };
    d.behaviour = BEHAVIOUR[msg.trim()] || msg.trim();
    await send(phone, `Where did you see them?\n(Type location name or share your GPS pin 📍)`);
    session.step = 4; return;
  }
  if (session.step === 4) {
    d.location = msg.trim();
    try {
      await sb.post('environment_observations', {
        observation_type: 'mammal',
        species:          d.species,
        count:            parseInt(d.count) || 1,
        behaviour:        d.behaviour,
        location_text:    d.location,
        recorded_by:      session.staffName,
        observed_at:      new Date().toISOString(),
        source:           'whatsapp'
      });
      await send(phone, `✅ *Sighting logged*\n🦁 ${d.count}x ${d.species}\n📍 ${d.location}\n🎯 ${d.behaviour}`);
      clearSession(phone);
    } catch(e) {
      await send(phone, '⚠ Error saving. Try again.'); clearSession(phone);
    }
    return;
  }
}

// ── FLOW: BIRD SIGHTING ───────────────────────────────────────
async function handleBird(phone, msg, session) {
  const d = session.data;

  if (session.step === 0) {
    await send(phone, '🦅 *Bird Sighting*\n\nWhat species did you see?');
    session.step = 1; return;
  }
  if (session.step === 1) {
    d.species = msg.trim();
    await send(phone, `How many *${d.species}*?`);
    session.step = 2; return;
  }
  if (session.step === 2) {
    d.count = msg.trim();
    await send(phone, `Where did you see them?\n(Type location or share GPS 📍)`);
    session.step = 3; return;
  }
  if (session.step === 3) {
    d.location = msg.trim();
    try {
      await sb.post('environment_observations', {
        observation_type: 'bird',
        species:          d.species,
        count:            parseInt(d.count) || 1,
        location_text:    d.location,
        recorded_by:      session.staffName,
        observed_at:      new Date().toISOString(),
        source:           'whatsapp'
      });
      await send(phone, `✅ *Bird sighting logged*\n🦅 ${d.count}x ${d.species}\n📍 ${d.location}`);
      clearSession(phone);
    } catch(e) {
      await send(phone, '⚠ Error saving. Try again.'); clearSession(phone);
    }
    return;
  }
}

// ── FLOW: MAP / FIELD POINT ───────────────────────────────────
async function handleMapPoint(phone, msg, session) {
  const d = session.data;

  if (session.step === 0) {
    await send(phone, '📍 *Field Point*\n\nWhat did you find?\n1. Invasive plant\n2. Erosion\n3. Fence damage\n4. Road issue\n5. Water issue\n6. Other');
    session.step = 1; return;
  }
  if (session.step === 1) {
    const TYPES = { '1':'invasive_plant','2':'erosion','3':'fence_damage','4':'road_issue','5':'water_issue','6':'other' };
    d.pointType = TYPES[msg.trim()] || 'other';
    await send(phone, 'Describe what you found:');
    session.step = 2; return;
  }
  if (session.step === 2) {
    d.description = msg.trim();
    await send(phone, `Priority?\n1. Low\n2. Medium\n3. High`);
    session.step = 3; return;
  }
  if (session.step === 3) {
    const PRI = { '1':'low','2':'medium','3':'high' };
    d.priority = PRI[msg.trim()] || 'medium';
    await send(phone, `📍 Share your GPS location or type the area name:`);
    session.step = 4; return;
  }
  if (session.step === 4) {
    d.location = msg.trim();
    try {
      await sb.post('environment_observations', {
        observation_type: 'map_point',
        observation_subtype: d.pointType,
        description:      d.description,
        priority:         d.priority,
        location_text:    d.location,
        recorded_by:      session.staffName,
        observed_at:      new Date().toISOString(),
        source:           'whatsapp'
      });
      await send(phone, `✅ *Field point logged*\n📍 ${d.pointType.replace(/_/g,' ')} — ${d.priority} priority\n📝 ${d.description}\n🗺 ${d.location}`);
      clearSession(phone);
    } catch(e) {
      await send(phone, '⚠ Error saving. Try again.'); clearSession(phone);
    }
    return;
  }
}

// ── FLOW: CHEMICAL USE ────────────────────────────────────────
async function handleChem(phone, msg, session) {
  const d = session.data;

  if (session.step === 0) {
    await send(phone, '⚗️ *Chemical Use*\n\nWhat chemical did you use?\n(Type the name)');
    session.step = 1; return;
  }
  if (session.step === 1) {
    try {
      const search = msg.trim().toLowerCase();
      const chems = await sb.get(`chemicals?name=ilike.*${encodeURIComponent(search)}*&limit=5`);
      if (!chems || !chems.length) {
        await send(phone, `No chemical found matching "${msg}". Check the name or contact management.`);
        clearSession(phone); return;
      }
      d.chem = chems[0];
      const ppe = d.chem.ppe_required || 'Gloves';
      await send(phone, `Found: *${d.chem.name}*\n\n⚠️ *PPE REQUIRED:* ${ppe}\n\nPut on your PPE now, then type *CONFIRMED* to proceed.`);
      session.step = 2;
    } catch(e) { await send(phone, '⚠ Error. Try again.'); clearSession(phone); }
    return;
  }
  if (session.step === 2) {
    if (msg.trim().toUpperCase() !== 'CONFIRMED') {
      await send(phone, `⛔ You must type *CONFIRMED* to confirm PPE is on before logging chemical use.\n\nThis is required for compliance.`);
      return;
    }
    await send(phone, `✓ PPE confirmed.\n\nHow much did you use? (e.g. "2 litres" or "500ml")`);
    session.step = 3; return;
  }
  if (session.step === 3) {
    d.quantity = msg.trim();
    await send(phone, `What area or species were you treating?`);
    session.step = 4; return;
  }
  if (session.step === 4) {
    d.target = msg.trim();
    try {
      await sb.post('chemical_usage', {
        chemical_id:   d.chem.id,
        chemical_name: d.chem.name,
        quantity_used: d.quantity,
        target:        d.target,
        ppe_confirmed: true,
        applied_by:    session.staffName,
        application_date: new Date().toISOString(),
        source:        'whatsapp'
      });
      await send(phone, `✅ *Chemical use logged*\n⚗️ ${d.chem.name}\n📊 ${d.quantity}\n🎯 ${d.target}\n🦺 PPE confirmed: ✓`);
      clearSession(phone);
    } catch(e) { await send(phone, '⚠ Error saving. Try again.'); clearSession(phone); }
    return;
  }
}

// ── FLOW: EMERGENCY ───────────────────────────────────────────
async function handleSOS(phone, session) {
  try {
    // Get all management staff
    const mgmt = await sb.get(`staff?department=eq.Management&is_active=eq.true`);
    // Create urgent task
    await sb.post('tasks', {
      title:       `🚨 EMERGENCY — reported by ${session.staffName}`,
      description: `Emergency alert received via WhatsApp from ${session.staffName} (${phone})`,
      priority:    'critical',
      status:      'created',
      type:        'incident',
      source:      'whatsapp',
      created_at:  new Date().toISOString()
    });
    // Notify all management
    for (const m of mgmt) {
      if (m.phone && m.phone !== phone) {
        await send(m.phone, `🚨 *EMERGENCY ALERT*\nReported by: *${session.staffName}*\nTime: ${new Date().toLocaleTimeString('en-ZA')}\n\nContact them immediately: ${phone}`);
      }
    }
    await send(phone, `🚨 *ALERT SENT*\n\nManagement has been notified.\n\nStay where you are. Help is coming.\n\nIf life-threatening — call *112* (emergency services)`);
    clearSession(phone);
  } catch(e) {
    await send(phone, `🚨 Alert system error. Call management directly or dial *112* for emergency services.`);
    clearSession(phone);
  }
}

// ── MAIN MESSAGE ROUTER ───────────────────────────────────────
async function handleMessage(phone, msg) {
  const session = getSession(phone);
  const text    = msg.trim().toLowerCase();

  // Global commands — work at any point
  if (['menu','start','hi','hello','hie','sawubona'].includes(text)) {
    clearSession(phone);
    const staff = await getStaff(phone);
    if (!staff) {
      await send(phone, `⛔ Your number is not registered in the Manyoni Ridge system.\n\nContact your manager to be added.`);
      return;
    }
    const s = getSession(phone);
    s.staffId   = staff.id;
    s.staffName = staff.preferred_name || staff.name;
    await send(phone, mainMenu(s.staffName));
    return;
  }

  if (['cancel','stop','khansela','quit'].includes(text)) {
    clearSession(phone);
    await send(phone, 'Cancelled ✓\n\nType *menu* to start again.');
    return;
  }

  // SOS — always works regardless of session
  if (text === 'sos' || text.includes('emergency') || text.includes('help')) {
    const staff = await getStaff(phone);
    if (staff) {
      const s = getSession(phone);
      s.staffName = staff.preferred_name || staff.name;
      await handleSOS(phone, s);
    } else {
      await send(phone, `🚨 Emergency alert — but your number is not registered.\n\nCall *112* for emergency services immediately.`);
    }
    return;
  }

  // If no active session — authenticate and show menu
  if (!session.flow) {
    const staff = await getStaff(phone);
    if (!staff) {
      await send(phone, `⛔ Your number (${phone}) is not registered in the Manyoni Ridge system.\n\nContact your manager to be added.`);
      return;
    }
    session.staffId   = staff.id;
    session.staffName = staff.preferred_name || staff.name;

    // Route from menu selection
    const FLOWS = {
      '1':'fuel', 'fuel':'fuel', 'petrol':'fuel', 'diesel':'fuel',
      '2':'task', 'task':'task', 'umsebenzi':'task',
      '3':'chem', 'chemical':'chem', 'chem':'chem',
      '4':'stock', 'stock':'stock', 'izinto':'stock',
      '5':'animal', 'animal':'animal', 'sighting':'animal',
      '6':'bird', 'bird':'bird',
      '7':'map', 'map':'map', 'point':'map', 'field':'map',
    };

    const flow = FLOWS[text];
    if (!flow) {
      await send(phone, mainMenu(session.staffName));
      return;
    }

    session.flow = flow;
    session.step = 0;
  }

  // Route to active flow
  try {
    switch(session.flow) {
      case 'fuel':   await handleFuel(phone, msg, session);   break;
      case 'stock':  await handleStock(phone, msg, session);  break;
      case 'task':   await handleTask(phone, msg, session);   break;
      case 'animal': await handleAnimal(phone, msg, session); break;
      case 'bird':   await handleBird(phone, msg, session);   break;
      case 'map':    await handleMapPoint(phone, msg, session); break;
      case 'chem':   await handleChem(phone, msg, session);   break;
      default:
        clearSession(phone);
        await send(phone, mainMenu(session.staffName || 'there'));
    }
  } catch(e) {
    console.error('Flow error:', e.message);
    await send(phone, '⚠ Something went wrong. Type *menu* to start again.');
    clearSession(phone);
  }
}

// ── WEBHOOK ROUTES ────────────────────────────────────────────

// Verification handshake (Meta calls this once when you register the webhook)
app.get('/webhook', (req, res) => {
  const mode      = req.query['hub.mode'];
  const token     = req.query['hub.verify_token'];
  const challenge = req.query['hub.challenge'];
  if (mode === 'subscribe' && token === VERIFY_TOKEN) {
    console.log('Webhook verified ✓');
    res.status(200).send(challenge);
  } else {
    console.error('Webhook verification failed');
    res.sendStatus(403);
  }
});

// Incoming messages
app.post('/webhook', async (req, res) => {
  // Always respond 200 immediately — Meta will retry if you're slow
  res.sendStatus(200);

  try {
    const entry   = req.body?.entry?.[0];
    const changes = entry?.changes?.[0];
    const value   = changes?.value;
    const message = value?.messages?.[0];

    if (!message) return; // status update, not a message

    const phone = message.from;
    const type  = message.type;
    let text    = '';

    if (type === 'text') {
      text = message.text?.body || '';
    } else if (type === 'location') {
      const loc = message.location;
      text = `GPS:${loc.latitude},${loc.longitude}`;
    } else if (type === 'image') {
      text = '[photo]';
    } else {
      // Unsupported type
      await send(phone, 'Please send a text message. Type *menu* to see options.');
      return;
    }

    console.log(`[${new Date().toISOString()}] ${phone}: ${text}`);
    await handleMessage(phone, text);

  } catch(e) {
    console.error('Webhook error:', e.message, e.stack);
  }
});

// Health check
app.get('/health', (req, res) => {
  res.json({
    status: 'ok',
    activeSessions: sessions.size,
    timestamp: new Date().toISOString()
  });
});

// Admin — active sessions
app.get('/admin/sessions', (req, res) => {
  const out = [];
  sessions.forEach((v, k) => {
    out.push({ phone: k.slice(0,-4)+'****', flow: v.flow, step: v.step, staff: v.staffName });
  });
  res.json(out);
});

app.listen(PORT, () => {
  console.log(`Manyoni Ridge Bot running on port ${PORT}`);
  console.log(`Webhook URL: https://YOUR-RAILWAY-URL/webhook`);
});
