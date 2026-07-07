const express = require('express');
const path = require('path');
const cookieParser = require('cookie-parser');
const bcrypt = require('bcryptjs');
const app = express();
const PORT = process.env.PORT || 3001;

app.set('view engine', 'ejs');
app.set('views', path.join(__dirname, 'views'));
app.use(express.static(path.join(__dirname, 'public')));
app.use(express.json());
app.use(express.urlencoded({ extended: true }));
app.use(cookieParser());

const supabase = require('./supabase');

// --- Auth Middleware ---
const requireAuth = (req, res, next) => {
  if (req.cookies.admin_session) {
    next();
  } else {
    if (req.path.startsWith('/api/')) {
      return res.status(401).json({ error: 'Unauthorized' });
    }
    res.redirect('/login');
  }
};

// --- Settings API Routes ---
app.post('/api/settings/password', async (req, res) => {
  const adminId = req.cookies.admin_session;
  if (!adminId) return res.redirect('/login');

  const { currentPassword, newPassword, confirmPassword } = req.body;

  if (newPassword !== confirmPassword) {
    return res.redirect('/settings/account?msg=New%20passwords%20do%20not%20match&type=error');
  }

  try {
    const { data: admin, error } = await supabase.from('admins').select('*').eq('id', adminId).single();
    if (error || !admin) {
      return res.redirect('/settings/account?msg=User%20not%20found&type=error');
    }

    const isMatch = await bcrypt.compare(currentPassword, admin.password_hash);
    if (!isMatch) {
      return res.redirect('/settings/account?msg=Incorrect%20current%20password&type=error');
    }

    const newHash = await bcrypt.hash(newPassword, 10);
    const { error: updateErr } = await supabase.from('admins').update({ password_hash: newHash }).eq('id', adminId);
    
    if (updateErr) throw updateErr;

    res.redirect('/settings/account?msg=Password%20updated%20successfully&type=success');
  } catch (err) {
    console.error('Error updating password:', err);
    res.redirect('/settings/account?msg=Failed%20to%20update%20password&type=error');
  }
});

// --- UI Routes ---
app.get('/login', (req, res) => {
  if (req.cookies.admin_session) return res.redirect('/dashboard');
  res.render('login', { error: null });
});

app.post('/login', async (req, res) => {
  const { username, password } = req.body;
  try {
    const { data, error } = await supabase.from('admins').select('*').eq('username', username).single();
    if (error || !data) {
      return res.render('login', { error: 'Invalid username or password' });
    }
    const isMatch = await bcrypt.compare(password, data.password_hash);
    if (!isMatch) {
      return res.render('login', { error: 'Invalid username or password' });
    }
    res.cookie('admin_session', data.id, { httpOnly: true, maxAge: 24 * 60 * 60 * 1000 }); // 1 day
    res.redirect('/');
  } catch (err) {
    res.render('login', { error: 'An error occurred during login' });
  }
});

app.get('/logout', (req, res) => {
  res.clearCookie('admin_session');
  res.redirect('/login');
});

// Protect all routes below this point
app.use(requireAuth);

// ─── Routes ──────────────────────────────────────────────────────────────────

// ─── Routes ──────────────────────────────────────────────────────────────────

app.get('/', (req, res) => res.redirect('/dashboard'));

app.get('/dashboard', async (req, res) => {
  try {
    const [
      { data: employees, error: empErr },
      { data: attendance, error: attErr },
      { data: locations, error: locErr }
    ] = await Promise.all([
      supabase.from('employees').select('*'),
      supabase.from('attendance').select('*'),
      supabase.from('locations').select('*')
    ]);
    if (empErr) throw empErr;
    if (attErr) throw attErr;
    if (locErr) throw locErr;

    const stats = {
      totalEmployees: employees?.length || 0,
      present: (attendance || []).filter(a => a.status === 'present').length,
      late:    (attendance || []).filter(a => a.status === 'late').length,
      absent:  (attendance || []).filter(a => a.status === 'absent').length,
    };
    
    // Attempt to map using user_id, fallback to raw user_id if not linked
    const recentAttendance = (attendance || []).slice(0, 5).map(a => {
      const emp = (employees || []).find(e => e.user_id === a.user_id);
      return {
        ...a,
        emp: emp || { id: a.user_id, name: 'User ' + (a.user_id ? a.user_id.substring(0,6) : 'Unknown'), initials: 'U', color: '#6B7280', position: 'Unlinked Account' }
      };
    });
    
    const weeklyDataMap = { 'Mon': {present:0, late:0, absent:0}, 'Tue': {present:0, late:0, absent:0}, 'Wed': {present:0, late:0, absent:0}, 'Thu': {present:0, late:0, absent:0}, 'Fri': {present:0, late:0, absent:0}, 'Sat': {present:0, late:0, absent:0}, 'Sun': {present:0, late:0, absent:0} };
    (attendance || []).forEach(a => {
      if(a.check_in_time) {
        const date = new Date(a.check_in_time);
        const dayName = date.toLocaleDateString('en-US', { weekday: 'short' });
        if(weeklyDataMap[dayName]) {
          const status = (a.status || '').toLowerCase();
          if(status === 'present') weeklyDataMap[dayName].present++;
          if(status === 'late') weeklyDataMap[dayName].late++;
          if(status === 'absent') weeklyDataMap[dayName].absent++;
        }
      }
    });
    const weeklyData = Object.keys(weeklyDataMap)
      .map(day => ({ day, ...weeklyDataMap[day] }))
      .filter(d => d.day !== 'Sat' && d.day !== 'Sun');

    let totalHours = 0, regularHours = 0, overtimeHours = 0, estPayroll = 0;
    (employees || []).forEach(e => {
      const eAtt = (attendance || []).filter(a => a.user_id === e.user_id);
      let daysWorked = 0;
      eAtt.forEach(a => {
        const s = (a.status || '').toLowerCase();
        if (s === 'present' || s === 'late') { 
          daysWorked += 1;
          totalHours += 8;
          regularHours += 8;
        }
      });
      const monthlySalary = parseFloat(e.monthly_salary) || 5000;
      const dailyRate = monthlySalary / 22;
      estPayroll += (daysWorked * dailyRate);
    });

    const payrollSummary = {
      totalHours: totalHours.toLocaleString(),
      regularHours: regularHours.toLocaleString(),
      overtimeHours: '0', // Overtime removed
      estPayroll: '$' + Math.round(estPayroll).toLocaleString()
    };
    
    const locationsWithCount = (locations || []).map(loc => ({
      ...loc,
      employees: (employees || []).filter(e => e.location === loc.name).length
    }));
    
    res.render('dashboard', { page: 'dashboard', stats, recentAttendance, weeklyData, payrollSummary, locations: locationsWithCount, employees: employees || [] });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: "Failed to load dashboard: " + err.message });
  }
});

app.get('/employees', async (req, res) => {
  try {
    const [
      { data: employees, error },
      { data: locations }
    ] = await Promise.all([
      supabase.from('employees').select('*'),
      supabase.from('locations').select('*')
    ]);
    if (error) throw error;
    // Normalize DB column names to what the template expects
    const normalized = (employees || []).map(e => ({
      ...e,
      joinDate: e.joindate || e.joinDate || '--',
      color:    e.color    || '#6366F1',
      initials: e.initials || (e.name ? e.name.split(' ').map(w => w[0]).join('').toUpperCase() : '?'),
    }));
    res.render('employees', { page: 'employees', employees: normalized, locations: locations || [] });
  } catch(err) {
    console.error('Employees route error:', err.message);
    res.status(500).json({ error: 'Failed to load employees: ' + err.message });
  }
});

app.get('/attendance', async (req, res) => {
  try {
    const [
      { data: employees },
      { data: attendance }
    ] = await Promise.all([
      supabase.from('employees').select('*'),
      supabase.from('attendance').select('*')
    ]);

    const records = (attendance || []).map(a => {
      const emp = (employees || []).find(e => e.user_id === a.user_id);
      return {
        ...a,
        emp: emp || { id: a.user_id, name: 'User ' + (a.user_id ? a.user_id.substring(0,6) : 'Unknown'), initials: 'U', color: '#6B7280', position: 'Unlinked Account', department: 'Unknown' }
      };
    });
    
    const stats = {
      total:   records.length,
      present: records.filter(r => r.status === 'present').length,
      late:    records.filter(r => r.status === 'late').length,
      absent:  records.filter(r => r.status === 'absent').length,
    };
    res.render('attendance', { page: 'attendance', records, stats });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: "Failed to load attendance: " + err.message });
  }
});

app.get('/locations', async (req, res) => {
  try {
    const [
      { data: locations },
      { data: employees },
      { data: attendance }
    ] = await Promise.all([
      supabase.from('locations').select('*'),
      supabase.from('employees').select('*'),
      supabase.from('attendance').select('*')
    ]);

    const locList = (locations || []).map(loc => {
      const empCount = (employees || []).filter(e => e.location === loc.name).length;
      
      const todayStart = new Date();
      todayStart.setHours(0,0,0,0);
      
      // Calculate real check-ins today
      const checkinsToday = (attendance || []).filter(a => {
        if (a.location !== loc.name) return false;
        const d = new Date(a.date || a.created_at || a.check_in_time);
        return d >= todayStart;
      }).length;

      const utilization = empCount > 0 ? Math.round((checkinsToday / empCount) * 100) : 0;

      return {
        ...loc,
        employees: empCount,
        checkins: checkinsToday,
        utilization: utilization
      };
    });
    const stats = {
      totalLocations: locList.length,
      activeSites: locList.filter(l => l.status === 'Active').length,
      totalEmployees: (employees || []).length,
      todayCheckins: (attendance || []).length
    };

    res.render('locations', { page: 'locations', locations: locList, stats });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: "Failed to load locations: " + err.message });
  }
});

app.get('/reports', async (req, res) => {
  try {
    const [
      { data: employees },
      { data: attendance }
    ] = await Promise.all([
      supabase.from('employees').select('*'),
      supabase.from('attendance').select('*')
    ]);

    const now = new Date();
    const currMonth = now.getMonth();
    const currYear = now.getFullYear();
    
    // Helpers for period filtering
    const isThisMonth = (d) => d.getMonth() === currMonth && d.getFullYear() === currYear;
    const isLastMonth = (d) => {
      const lm = currMonth === 0 ? 11 : currMonth - 1;
      const ly = currMonth === 0 ? currYear - 1 : currYear;
      return d.getMonth() === lm && d.getFullYear() === ly;
    };
    const isThisQuarter = (d) => {
      const currQ = Math.floor(currMonth / 3);
      const q = Math.floor(d.getMonth() / 3);
      return q === currQ && d.getFullYear() === currYear;
    };

    const buildStats = (empList, attList, filterFn) => {
      const filteredAtt = attList.filter(a => {
        if (!a.check_in_time && !a.date && !a.created_at) return false;
        const d = new Date(a.check_in_time || a.date || a.created_at);
        return filterFn(d);
      });

      // Calculate unique working days (days where at least 1 person checked in)
      const uniqueDays = new Set();
      let totalCheckins = 0;
      let totalMinutes = 0;

      const deptsMap = {};
      empList.forEach(e => {
        const dept = e.department || 'General';
        if(!deptsMap[dept]) deptsMap[dept] = { dept, empCount: 0, present: 0 };
        deptsMap[dept].empCount++;
      });

      filteredAtt.forEach(a => {
        const d = new Date(a.check_in_time || a.date || a.created_at);
        uniqueDays.add(d.toDateString());
        
        if (a.status === 'present' || a.status === 'late') {
          totalCheckins++;
          if (a.check_in_time) {
            totalMinutes += (d.getHours() * 60) + d.getMinutes();
          }
          
          const emp = empList.find(e => e.user_id === a.user_id);
          if (emp) {
             const dept = emp.department || 'General';
             if(deptsMap[dept]) deptsMap[dept].present++;
          }
        }
      });

      const workDays = uniqueDays.size;
      const expectedTotal = empList.length * (workDays || 1); // rough rate estimation
      const rate = expectedTotal > 0 ? Math.round((totalCheckins / expectedTotal) * 100) : 0;

      let avgTimeString = '--:-- AM';
      if(totalCheckins > 0 && totalMinutes > 0) {
        const avgMins = Math.round(totalMinutes / totalCheckins);
        const h = Math.floor(avgMins / 60);
        const m = avgMins % 60;
        const ampm = h >= 12 ? 'PM' : 'AM';
        const h12 = h % 12 || 12;
        avgTimeString = `${h12}:${m.toString().padStart(2, '0')} ${ampm}`;
      }

      // We don't track check_out_time, so avgHours is N/A
      const avgHours = '--';

      const deptsArray = Object.values(deptsMap).map(d => ({
        dept: d.dept,
        total: d.empCount * (workDays || 1),
        present: d.present
      }));

      return {
        summary: { workDays: workDays.toString(), avgCheckin: avgTimeString, rate: rate + '%', avgHours },
        depts: deptsArray
      };
    };

    const reportPeriods = {
      month: { label: 'This Month', ...buildStats(employees || [], attendance || [], isThisMonth) },
      lastmonth: { label: 'Last Month', ...buildStats(employees || [], attendance || [], isLastMonth) },
      quarter: { label: 'This Quarter', ...buildStats(employees || [], attendance || [], isThisQuarter) }
    };

    res.render('reports', { page: 'reports', reportPeriods, employees: employees || [] });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: "Failed to load reports: " + err.message });
  }
});

app.get('/payroll', async (req, res) => {
  try {
    const currMonth = new Date().toLocaleString('default', { month: 'long', year: 'numeric' });
    const [
      { data: employees },
      { data: attendance },
      { data: savedPayroll }
    ] = await Promise.all([
      supabase.from('employees').select('*'),
      supabase.from('attendance').select('*'),
      supabase.from('payroll').select('*').eq('month', currMonth)
    ]);

    let totalGross = 0, totalNet = 0, paidCount = 0, otHours = 0;
    const deptPayMap = {};

    const payroll = (employees || []).map(e => {
      let gp = 0;
      let np = 0;
      let rhrStr = '0h';
      let st = 'Pending';
      
      const saved = (savedPayroll || []).find(p => p.user_id === e.user_id);
      
      if (saved) {
        gp = parseFloat(saved.gross_pay) || 0;
        np = parseFloat(saved.net_pay) || 0;
        rhrStr = (saved.regular_hours || 0) + 'h';
        st = saved.status || 'Processing';
      } else {
        const att = (attendance || []).filter(a => a.user_id === e.user_id);
        let daysWorked = 0; 
        att.forEach(a => {
          const status = (a.status||'').toLowerCase();
          if(status === 'present' || status === 'late') { daysWorked += 1; }
        });
        const monthlySalary = parseFloat(e.monthly_salary) || 5000;
        const dailyRate = monthlySalary / 22;
        gp = (daysWorked * dailyRate);
        np = gp * 0.9;
        rhrStr = (daysWorked * 8) + 'h';
      }
      
      totalGross += gp;
      totalNet += np;

      if(!deptPayMap[e.department]) deptPayMap[e.department] = { name: e.department || 'General', count: 0, val: 0 };
      deptPayMap[e.department].count++;
      deptPayMap[e.department].val += gp;

      if(st === 'Paid') paidCount++;
      
      return { 
        id: e.id || e.user_id?.substring(0,8), 
        name: e.name || 'Unknown', 
        loc: e.location || 'Main Office',
        dept: e.department || 'General', 
        rhr: rhrStr, 
        ohr: '—',  
        gp: '$'+Math.round(gp).toLocaleString(), 
        np: '$'+Math.round(np).toLocaleString(), 
        st, 
        clr: e.color || '#3b82f6'
      };
    });

    const maxVal = Math.max(...Object.values(deptPayMap).map(d=>d.val), 1);
    const deptPay = Object.values(deptPayMap).map(d => ({...d, pct: Math.round((d.val/maxVal)*100)}));

    res.render('payroll', { page: 'payroll', payroll, stats: { totalGross, totalNet, paidCount, otHours, deptPay } });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: "Failed to load payroll: " + err.message });
  }
});

// API Routes for Employees
  async function syncLocationEmployeeCounts() {
    try {
      const [
        { data: emps },
        { data: locs }
      ] = await Promise.all([
        supabase.from('employees').select('location'),
        supabase.from('locations').select('id, name')
      ]);
      if (!emps || !locs) return;
      await Promise.all(locs.map(loc => {
        const count = emps.filter(e => e.location === loc.name).length;
        return supabase.from('locations').update({ employees: count }).eq('id', loc.id);
      }));
    } catch (err) {
      console.error("Failed to sync location counts:", err);
    }
  }

  app.post('/api/employees', async (req, res) => {
    const { data, error } = await supabase.from('employees').insert([req.body]).select();
    if (error) return res.status(500).json({ error: error.message });
    await syncLocationEmployeeCounts();
    res.json(data[0]);
  });
  
  app.put('/api/employees/:id', async (req, res) => {
    const { data, error } = await supabase.from('employees').update(req.body).eq('id', req.params.id).select();
    if (error) return res.status(500).json({ error: error.message });
    await syncLocationEmployeeCounts();
    res.json(data[0]);
  });
  
  app.delete('/api/employees/:id', async (req, res) => {
    const { data, error } = await supabase.from('employees').delete().eq('id', req.params.id).select();
    if (error) return res.status(500).json({ error: error.message });
    await syncLocationEmployeeCounts();
    res.json({ success: true, data });
  });

// API Routes for Locations
app.post('/api/locations', async (req, res) => {
  const { data, error } = await supabase.from('locations').insert([req.body]).select();
  if (error) return res.status(500).json({ error: error.message });
  res.json(data[0]);
});

// Payroll API Routes
app.post('/api/payroll/generate', async (req, res) => {
  try {
    const currMonth = new Date().toLocaleString('default', { month: 'long', year: 'numeric' });
    const [
      { data: employees },
      { data: attendance },
      { data: savedPayroll }
    ] = await Promise.all([
      supabase.from('employees').select('*'),
      supabase.from('attendance').select('*'),
      supabase.from('payroll').select('*').eq('month', currMonth)
    ]);
    
    if(!employees || employees.length === 0) return res.json({ success: true, count: 0 });

    let count = 0;
    await Promise.all(employees.map(async (e) => {
      const saved = (savedPayroll || []).find(p => p.user_id === e.user_id);
      if (saved && saved.status === 'Paid') return; // Skip if already paid
      
      const att = (attendance || []).filter(a => a.user_id === e.user_id);
      let daysWorked = 0; 
      att.forEach(a => {
        const status = (a.status||'').toLowerCase();
        if(status === 'present' || status === 'late') { daysWorked += 1; }
      });
      const monthlySalary = parseFloat(e.monthly_salary) || 5000;
      const dailyRate = monthlySalary / 22;
      const gp = (daysWorked * dailyRate);
      const np = gp * 0.9;
      const rhr = (daysWorked * 8);

      const record = {
        user_id: e.user_id,
        month: currMonth,
        regular_hours: rhr,
        overtime_hours: 0,
        gross_pay: gp,
        net_pay: np,
        status: 'Processing'
      };

      if (saved) {
        await supabase.from('payroll').update(record).eq('id', saved.id);
      } else {
        await supabase.from('payroll').insert([record]);
      }
      count++;
    }));
    res.json({ success: true, count });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: err.message });
  }
});

app.post('/api/payroll/process', async (req, res) => {
  try {
    const currMonth = new Date().toLocaleString('default', { month: 'long', year: 'numeric' });
    const { error } = await supabase.from('payroll')
      .update({ status: 'Paid' })
      .eq('month', currMonth)
      .neq('status', 'Paid');
      
    if (error) throw error;
    res.json({ success: true });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: err.message });
  }
});

app.put('/api/locations/:id', async (req, res) => {
  const { data, error } = await supabase.from('locations').update(req.body).eq('id', req.params.id).select();
  if (error) return res.status(500).json({ error: error.message });
  res.json(data[0]);
});

app.delete('/api/locations/:id', async (req, res) => {
  const { error } = await supabase.from('locations').delete().eq('id', req.params.id);
  if (error) return res.status(500).json({ error: error.message });
  res.json({ success: true });
});

app.get('/settings', (req, res) => res.render('settings', { page: 'settings', subPage: 'hub' }));
app.get('/settings/appearance', (req, res) => res.render('settings-appearance', { page: 'settings', subPage: 'appearance' }));
app.get('/settings/attendance', (req, res) => res.render('settings-attendance', { page: 'settings', subPage: 'attendance' }));
app.get('/settings/locations', (req, res) => res.render('settings-locations', { page: 'settings', subPage: 'locations' }));
app.get('/settings/payroll', (req, res) => res.render('settings-payroll', { page: 'settings', subPage: 'payroll' }));
app.get('/settings/account', (req, res) => res.render('settings-account', { page: 'settings', subPage: 'account' }));
// ─── Start ───────────────────────────────────────────────────────────────────
if (process.env.NODE_ENV !== 'production') {
  app.listen(PORT, () => {
    console.log(`\n  ✅  GeoLock Attendance Dashboard running at http://localhost:${PORT}\n`);
  });
}

// Export for Vercel Serverless Functions
module.exports = app;
