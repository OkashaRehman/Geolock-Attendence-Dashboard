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

// ─── Helper: normalize a profiles row into the shape the entire dashboard expects ───
// profiles.id  IS the UUID that attendance.user_id references.
function normalizeProfile(p) {
  const name = p.full_name || 'Unknown';
  const initials = p.initials || name.split(' ').filter(Boolean).map(w => w[0]).join('').toUpperCase().substring(0, 2) || '?';
  const color    = p.color || '#6366F1';
  return {
    ...p,
    name,
    user_id: p.id,   // <-- key link: profiles.id === attendance.user_id
    initials,
    color,
    joinDate: p.joindate || '--',
    department: p.department || 'General',
    position: p.position || p.role || '--',
    email: p.email || '--',
    phone: p.phone || '--',
    status: p.status || 'Active',
    monthly_salary: p.monthly_salary || 5000,
    location: p.location || '',
    picture: p.picture || null,
  };
}

// ─── Helper: normalize an organizations row into the shape the dashboard expects ─
function normalizeOrg(o) {
  return {
    ...o,
    name:    o.name || 'Unknown',
    lat:     o.office_latitude  || null,
    lng:     o.office_longitude || null,
    radius:  o.geofence_radius_meters || 100,
    address: o.address || (o.office_latitude ? `${Number(o.office_latitude).toFixed(4)}, ${Number(o.office_longitude).toFixed(4)}` : '--'),
    status:  o.status || 'Active',
    employees: o.employees || 0,
  };
}

// ─── Auth Middleware ──────────────────────────────────────────────────────────
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

// ─── Settings API Routes ──────────────────────────────────────────────────────
app.post('/api/settings/password', async (req, res) => {
  const adminId = req.cookies.admin_session;
  if (!adminId) return res.redirect('/login');

  const { currentPassword, newPassword, confirmPassword } = req.body;

  if (newPassword !== confirmPassword) {
    return res.redirect('/settings/account?msg=New%20passwords%20do%20not%20match&type=error');
  }

  try {
    // 1. Get user email from profiles
    const { data: profile, error: profileErr } = await supabase.from('profiles').select('email').eq('id', adminId).single();
    if (profileErr || !profile) {
      return res.redirect('/settings/account?msg=User%20not%20found&type=error');
    }

    // 2. Verify current password by signing in
    const { data: authData, error: authErr } = await supabase.auth.signInWithPassword({
      email: profile.email,
      password: currentPassword
    });

    if (authErr) {
      return res.redirect('/settings/account?msg=Incorrect%20current%20password&type=error');
    }

    // 3. Update password using admin API
    const { error: updateErr } = await supabase.auth.admin.updateUserById(adminId, {
      password: newPassword
    });
    
    if (updateErr) throw updateErr;

    res.redirect('/settings/account?msg=Password%20updated%20successfully&type=success');
  } catch (err) {
    console.error('Error updating password:', err);
    res.redirect('/settings/account?msg=Failed%20to%20update%20password&type=error');
  }
});

// ─── UI Routes ────────────────────────────────────────────────────────────────
app.get('/login', (req, res) => {
  if (req.cookies.admin_session) return res.redirect('/dashboard');
  res.render('login', { error: null });
});

app.post('/login', async (req, res) => {
  const { email, password } = req.body;
  try {
    // 1. Authenticate with Supabase Auth
    const { data: authData, error: authError } = await supabase.auth.signInWithPassword({ email, password });
    
    if (authError || !authData.user) {
      return res.render('login', { error: 'Invalid email or password' });
    }

    // 2. Check if the user is an admin in the profiles table
    const { data: profileData, error: profileError } = await supabase
      .from('profiles')
      .select('role')
      .eq('id', authData.user.id)
      .single();

    if (profileError || !profileData || profileData.role !== 'admin') {
      return res.render('login', { error: 'Access denied: User is not an admin' });
    }

    // 3. Set the cookie and log them in
    res.cookie('admin_session', authData.user.id, { httpOnly: true, maxAge: 24 * 60 * 60 * 1000 });
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

app.get('/', (req, res) => res.redirect('/dashboard'));

app.get('/dashboard', async (req, res) => {
  try {
    const [
      { data: rawProfiles, error: empErr },
      { data: attendance, error: attErr },
      { data: rawOrgs, error: locErr }
    ] = await Promise.all([
      supabase.from('profiles').select('*'),
      supabase.from('attendance').select('*'),
      supabase.from('organizations').select('*')
    ]);
    if (empErr) throw empErr;
    if (attErr) throw attErr;
    if (locErr) throw locErr;

    const employees  = (rawProfiles || []).map(normalizeProfile);
    const locations  = (rawOrgs     || []).map(normalizeOrg);

    const stats = {
      totalEmployees: employees.length,
      present: (attendance || []).filter(a => a.status === 'present').length,
      late:    (attendance || []).filter(a => a.status === 'late').length,
      absent:  (attendance || []).filter(a => a.status === 'absent').length,
    };
    
    const recentAttendance = (attendance || []).slice(0, 5).map(a => {
      const emp = employees.find(e => e.user_id === a.user_id);
      return {
        ...a,
        emp: emp || { name: 'User ' + (a.user_id ? a.user_id.substring(0, 6) : 'Unknown'), initials: 'U', color: '#6B7280', position: 'Unknown Employee' }
      };
    });
    
    const weeklyDataMap = { 'Mon': {present:0, late:0, absent:0}, 'Tue': {present:0, late:0, absent:0}, 'Wed': {present:0, late:0, absent:0}, 'Thu': {present:0, late:0, absent:0}, 'Fri': {present:0, late:0, absent:0}, 'Sat': {present:0, late:0, absent:0}, 'Sun': {present:0, late:0, absent:0} };
    (attendance || []).forEach(a => {
      if (a.check_in_time) {
        const date = new Date(a.check_in_time);
        const dayName = date.toLocaleDateString('en-US', { weekday: 'short' });
        if (weeklyDataMap[dayName]) {
          const status = (a.status || '').toLowerCase();
          if (status === 'present') weeklyDataMap[dayName].present++;
          if (status === 'late') weeklyDataMap[dayName].late++;
          if (status === 'absent') weeklyDataMap[dayName].absent++;
        }
      }
    });
    const weeklyData = Object.keys(weeklyDataMap)
      .map(day => ({ day, ...weeklyDataMap[day] }))
      .filter(d => d.day !== 'Sat' && d.day !== 'Sun');

    let totalHours = 0, regularHours = 0, estPayroll = 0;
    employees.forEach(e => {
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
      estPayroll += (daysWorked * (monthlySalary / 22));
    });

    const payrollSummary = {
      totalHours: totalHours.toLocaleString(),
      regularHours: regularHours.toLocaleString(),
      overtimeHours: '0',
      estPayroll: '$' + Math.round(estPayroll).toLocaleString()
    };
    
    const locationsWithCount = (locations || []).map(loc => ({
      ...loc,
      employees: employees.filter(e => e.location === loc.name).length
    }));
    
    res.render('dashboard', { page: 'dashboard', stats, recentAttendance, weeklyData, payrollSummary, locations: locationsWithCount, employees });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: "Failed to load dashboard: " + err.message });
  }
});

app.get('/employees', async (req, res) => {
  try {
    const [
      { data: rawProfiles, error },
      { data: rawOrgs }
    ] = await Promise.all([
      supabase.from('profiles').select('*'),
      supabase.from('organizations').select('*')
    ]);
    if (error) throw error;
    const employees = (rawProfiles || []).map(normalizeProfile);
    const locations = (rawOrgs     || []).map(normalizeOrg);
    res.render('employees', { page: 'employees', employees, locations });
  } catch (err) {
    console.error('Employees route error:', err.message);
    res.status(500).json({ error: 'Failed to load employees: ' + err.message });
  }
});

app.get('/attendance', async (req, res) => {
  try {
    const [
      { data: rawProfiles },
      { data: attendance },
      { data: rawOrgs }
    ] = await Promise.all([
      supabase.from('profiles').select('*'),
      supabase.from('attendance').select('*'),
      supabase.from('organizations').select('*')
    ]);

    const employees = (rawProfiles || []).map(normalizeProfile);
    const locations = (rawOrgs || []).map(normalizeOrg);

    const records = (attendance || []).map(a => {
      const emp = employees.find(e => e.user_id === a.user_id);
      return {
        ...a,
        emp: emp || { name: 'User ' + (a.user_id ? a.user_id.substring(0, 6) : 'Unknown'), initials: 'U', color: '#6B7280', position: 'Unknown', department: 'Unknown' }
      };
    });
    
    const stats = {
      total:   records.length,
      present: records.filter(r => r.status === 'present').length,
      late:    records.filter(r => r.status === 'late').length,
      absent:  records.filter(r => r.status === 'absent').length,
    };
    res.render('attendance', { page: 'attendance', records, stats, employees, locations });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: "Failed to load attendance: " + err.message });
  }
});

app.get('/locations', async (req, res) => {
  try {
    const [
      { data: rawOrgs },
      { data: rawProfiles },
      { data: attendance }
    ] = await Promise.all([
      supabase.from('organizations').select('*'),
      supabase.from('profiles').select('*'),
      supabase.from('attendance').select('*')
    ]);

    const locations = (rawOrgs     || []).map(normalizeOrg);
    const employees = (rawProfiles || []).map(normalizeProfile);

    const todayStart = new Date();
    todayStart.setHours(0, 0, 0, 0);

    const locList = locations.map(loc => {
      const empCount = employees.filter(e => e.location === loc.name).length;
      // Match via org_id (mobile link) OR location name fallback
      const checkinsToday = (attendance || []).filter(a => {
        const matchOrg  = a.org_id === loc.id;
        const matchName = a.location === loc.name;
        if (!matchOrg && !matchName) return false;
        const d = new Date(a.date || a.created_at || a.check_in_time);
        return d >= todayStart;
      }).length;
      const utilization = empCount > 0 ? Math.round((checkinsToday / empCount) * 100) : 0;
      return { ...loc, employees: empCount, checkins: checkinsToday, utilization };
    });

    const stats = {
      totalLocations: locList.length,
      activeSites: locList.filter(l => l.status === 'Active').length,
      totalEmployees: employees.length,
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
      { data: rawProfiles },
      { data: attendance }
    ] = await Promise.all([
      supabase.from('profiles').select('*'),
      supabase.from('attendance').select('*')
    ]);

    const employees = (rawProfiles || []).map(normalizeProfile);

    const now = new Date();
    const currMonth = now.getMonth();
    const currYear  = now.getFullYear();

    const isThisMonth  = (d) => d.getMonth() === currMonth && d.getFullYear() === currYear;
    const isLastMonth  = (d) => {
      const lm = currMonth === 0 ? 11 : currMonth - 1;
      const ly = currMonth === 0 ? currYear - 1 : currYear;
      return d.getMonth() === lm && d.getFullYear() === ly;
    };
    const isThisQuarter = (d) => {
      const currQ = Math.floor(currMonth / 3);
      return Math.floor(d.getMonth() / 3) === currQ && d.getFullYear() === currYear;
    };

    const buildStats = (empList, attList, filterFn) => {
      const filteredAtt = attList.filter(a => {
        if (!a.check_in_time && !a.date && !a.created_at) return false;
        return filterFn(new Date(a.check_in_time || a.date || a.created_at));
      });

      const uniqueDays = new Set();
      let totalCheckins = 0, totalMinutes = 0;

      const deptsMap = {};
      empList.forEach(e => {
        const dept = e.department || 'General';
        if (!deptsMap[dept]) deptsMap[dept] = { dept, empCount: 0, present: 0 };
        deptsMap[dept].empCount++;
      });

      filteredAtt.forEach(a => {
        const d = new Date(a.check_in_time || a.date || a.created_at);
        uniqueDays.add(d.toDateString());
        if (a.status === 'present' || a.status === 'late') {
          totalCheckins++;
          if (a.check_in_time) totalMinutes += (d.getHours() * 60) + d.getMinutes();
          const emp = empList.find(e => e.user_id === a.user_id);
          if (emp && deptsMap[emp.department || 'General']) deptsMap[emp.department || 'General'].present++;
        }
      });

      const workDays = uniqueDays.size;
      const expectedTotal = empList.length * (workDays || 1);
      const rate = expectedTotal > 0 ? Math.round((totalCheckins / expectedTotal) * 100) : 0;

      let avgTimeString = '--:-- AM';
      if (totalCheckins > 0 && totalMinutes > 0) {
        const avgMins = Math.round(totalMinutes / totalCheckins);
        const h = Math.floor(avgMins / 60);
        const m = avgMins % 60;
        const ampm = h >= 12 ? 'PM' : 'AM';
        avgTimeString = `${h % 12 || 12}:${m.toString().padStart(2, '0')} ${ampm}`;
      }

      const deptsArray = Object.values(deptsMap).map(d => ({
        dept: d.dept,
        total: d.empCount * (workDays || 1),
        present: d.present
      }));

      return {
        summary: { workDays: workDays.toString(), avgCheckin: avgTimeString, rate: rate + '%', avgHours: '--' },
        depts: deptsArray
      };
    };

    const reportPeriods = {
      month:     { label: 'This Month',   ...buildStats(employees, attendance || [], isThisMonth) },
      lastmonth: { label: 'Last Month',   ...buildStats(employees, attendance || [], isLastMonth) },
      quarter:   { label: 'This Quarter', ...buildStats(employees, attendance || [], isThisQuarter) }
    };

    res.render('reports', { page: 'reports', reportPeriods, employees });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: "Failed to load reports: " + err.message });
  }
});

app.get('/payroll', async (req, res) => {
  try {
    const currMonth = new Date().toLocaleString('default', { month: 'long', year: 'numeric' });
    const [
      { data: rawProfiles },
      { data: attendance },
      { data: savedPayroll }
    ] = await Promise.all([
      supabase.from('profiles').select('*'),
      supabase.from('attendance').select('*'),
      supabase.from('payroll').select('*').eq('month', currMonth)
    ]);

    const employees = (rawProfiles || []).map(normalizeProfile);

    let totalGross = 0, totalNet = 0, paidCount = 0, otHours = 0;
    const deptPayMap = {};

    const payroll = employees.map(e => {
      let gp = 0, np = 0, rhrStr = '0h', st = 'Pending';
      
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
          if ((a.status || '').toLowerCase() === 'present' || (a.status || '').toLowerCase() === 'late') daysWorked++;
        });
        const monthlySalary = parseFloat(e.monthly_salary) || 5000;
        gp = daysWorked * (monthlySalary / 22);
        np = gp * 0.9;
        rhrStr = (daysWorked * 8) + 'h';
      }

      totalGross += gp;
      totalNet   += np;
      const dept = e.department || 'General';
      if (!deptPayMap[dept]) deptPayMap[dept] = { name: dept, count: 0, val: 0 };
      deptPayMap[dept].count++;
      deptPayMap[dept].val += gp;
      if (st === 'Paid') paidCount++;

      return {
        id:   e.id,
        name: e.name,
        loc:  e.location || 'Main Office',
        dept,
        rhr:  rhrStr,
        ohr:  '—',
        gp:   '$' + Math.round(gp).toLocaleString(),
        np:   '$' + Math.round(np).toLocaleString(),
        st,
        clr:  e.color || '#3b82f6'
      };
    });

    const maxVal = Math.max(...Object.values(deptPayMap).map(d => d.val), 1);
    const deptPay = Object.values(deptPayMap).map(d => ({ ...d, pct: Math.round((d.val / maxVal) * 100) }));

    res.render('payroll', { page: 'payroll', payroll, stats: { totalGross, totalNet, paidCount, otHours, deptPay } });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: "Failed to load payroll: " + err.message });
  }
});

// ─── API Routes for Employees (backed by profiles table) ─────────────────────

async function syncLocationEmployeeCounts() {
  try {
    const [
      { data: emps },
      { data: locs }
    ] = await Promise.all([
      supabase.from('profiles').select('location'),
      supabase.from('organizations').select('id, name')
    ]);
    if (!emps || !locs) return;
    await Promise.all(locs.map(loc => {
      const count = emps.filter(e => e.location === loc.name).length;
      return supabase.from('organizations').update({ employees: count }).eq('id', loc.id);
    }));
  } catch (err) {
    console.error("Failed to sync location counts:", err);
  }
}

app.post('/api/employees', async (req, res) => {
  try {
    if (!process.env.SUPABASE_SERVICE_KEY) {
      return res.status(500).json({ error: "SUPABASE_SERVICE_KEY is required in .env to create users." });
    }

    const { name, initials, color, department, position, email, phone, status, joindate, monthly_salary, location, picture, role, password } = req.body;
    
    // 1. Create Auth user so they can log into the mobile app
    const { data: authData, error: authError } = await supabase.auth.admin.createUser({
      email,
      password,
      email_confirm: true,
      user_metadata: { full_name: name }
    });

    if (authError) {
      return res.status(500).json({ error: "Auth Error: " + authError.message });
    }

    const newUserId = authData.user.id;

    // Find the organization ID based on the selected location name
    let org_id = null;
    if (location) {
      const { data: orgData } = await supabase.from('organizations').select('id').eq('name', location).single();
      if (orgData) org_id = orgData.id;
    }

    // 2. Insert into profiles with the new user ID
    const profilePayload = {
      id: newUserId,
      org_id,
      full_name: name,
      role: role || 'employee',
      initials,
      color,
      department,
      position,
      email,
      phone,
      status,
      joindate,
      monthly_salary,
      location,
      picture
    };
    
    // Use upsert in case a database trigger already created the profile row
    const { data, error } = await supabase.from('profiles').upsert([profilePayload]).select();
    if (error) return res.status(500).json({ error: "Profile Error: " + error.message });
    
    await syncLocationEmployeeCounts();
    res.json(normalizeProfile(data[0]));
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

app.put('/api/employees/:id', async (req, res) => {
  try {
    const { name, department, position, email, phone, status, joindate, monthly_salary, location, picture, role } = req.body;
    
    // Find the organization ID based on the selected location name
    let org_id = null;
    if (location) {
      const { data: orgData } = await supabase.from('organizations').select('id').eq('name', location).single();
      if (orgData) org_id = orgData.id;
    }

    const profilePayload = {
      full_name: name,
      org_id,
      department,
      position,
      email,
      phone,
      status,
      joindate,
      monthly_salary,
      location,
      picture
    };
    if (role) profilePayload.role = role;
    
    const { data, error } = await supabase.from('profiles').update(profilePayload).eq('id', req.params.id).select();
    if (error) return res.status(500).json({ error: error.message });
    await syncLocationEmployeeCounts();
    res.json(normalizeProfile(data[0]));
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

app.delete('/api/employees/:id', async (req, res) => {
  try {
    const { data, error } = await supabase.from('profiles').delete().eq('id', req.params.id).select();
    if (error) return res.status(500).json({ error: error.message });
    await syncLocationEmployeeCounts();
    res.json({ success: true, data });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// ─── API Routes for Locations (backed by organizations table) ──────────────────
app.post('/api/locations', async (req, res) => {
  // Map dashboard field names to organizations columns
  const { name, lat, lng, radius, address } = req.body;
  
  // Generate a random 7-character alphanumeric invite code (like A4S4PLN)
  const invite_code = Math.random().toString(36).substring(2, 9).toUpperCase();

  // Find an admin to set as the owner_id (required by the database)
  const { data: admins } = await supabase.from('profiles').select('id').eq('role', 'admin').limit(1);
  const owner_id = (admins && admins.length > 0) ? admins[0].id : null;

  const payload = {
    name,
    invite_code,
    owner_id,
    office_latitude: lat,
    office_longitude: lng,
    geofence_radius_meters: parseInt(radius) || 100,
    address,
    status: req.body.status || 'Active'
  };
  const { data, error } = await supabase.from('organizations').insert([payload]).select();
  if (error) return res.status(500).json({ error: error.message });
  res.json(normalizeOrg(data[0]));
});

app.put('/api/locations/:id', async (req, res) => {
  const { name, lat, lng, radius, address, status } = req.body;
  const payload = {};
  if (name    !== undefined) payload.name = name;
  if (lat     !== undefined) payload.office_latitude = lat;
  if (lng     !== undefined) payload.office_longitude = lng;
  if (radius  !== undefined) payload.geofence_radius_meters = parseInt(radius) || 100;
  if (address !== undefined) payload.address = address;
  if (status  !== undefined) payload.status  = status;
  const { data, error } = await supabase.from('organizations').update(payload).eq('id', req.params.id).select();
  if (error) return res.status(500).json({ error: error.message });
  res.json(normalizeOrg(data[0]));
});

app.delete('/api/locations/:id', async (req, res) => {
  const { error } = await supabase.from('organizations').delete().eq('id', req.params.id);
  if (error) return res.status(500).json({ error: error.message });
  res.json({ success: true });
});

// ─── Payroll API Routes ───────────────────────────────────────────────────────
app.post('/api/payroll/generate', async (req, res) => {
  try {
    const currMonth = new Date().toLocaleString('default', { month: 'long', year: 'numeric' });
    const [
      { data: rawProfiles },
      { data: attendance },
      { data: savedPayroll }
    ] = await Promise.all([
      supabase.from('profiles').select('*'),
      supabase.from('attendance').select('*'),
      supabase.from('payroll').select('*').eq('month', currMonth)
    ]);

    const employees = (rawProfiles || []).map(normalizeProfile);
    if (!employees.length) return res.json({ success: true, count: 0 });

    let count = 0;
    await Promise.all(employees.map(async (e) => {
      const saved = (savedPayroll || []).find(p => p.user_id === e.user_id);
      if (saved && saved.status === 'Paid') return;

      const att = (attendance || []).filter(a => a.user_id === e.user_id);
      let daysWorked = 0;
      att.forEach(a => {
        if ((a.status || '').toLowerCase() === 'present' || (a.status || '').toLowerCase() === 'late') daysWorked++;
      });
      const monthlySalary = parseFloat(e.monthly_salary) || 5000;
      const gp = daysWorked * (monthlySalary / 22);

      const record = {
        user_id: e.user_id,
        month: currMonth,
        regular_hours: daysWorked * 8,
        overtime_hours: 0,
        gross_pay: gp,
        net_pay: gp * 0.9,
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

// ─── Settings Pages ───────────────────────────────────────────────────────────
app.get('/settings', (req, res) => res.render('settings', { page: 'settings', subPage: 'hub' }));
app.get('/settings/appearance', (req, res) => res.render('settings-appearance', { page: 'settings', subPage: 'appearance' }));
app.get('/settings/attendance', (req, res) => res.render('settings-attendance', { page: 'settings', subPage: 'attendance' }));
app.get('/settings/locations', (req, res) => res.render('settings-locations', { page: 'settings', subPage: 'locations' }));
app.get('/settings/payroll', (req, res) => res.render('settings-payroll', { page: 'settings', subPage: 'payroll' }));
app.get('/settings/account', (req, res) => res.render('settings-account', { page: 'settings', subPage: 'account' }));

// ─── Start ────────────────────────────────────────────────────────────────────
if (process.env.NODE_ENV !== 'production') {
  app.listen(PORT, () => {
    console.log(`\n  ✅  GeoLock Attendance Dashboard running at http://localhost:${PORT}\n`);
  });
}

// Export for Vercel Serverless Functions
module.exports = app;
