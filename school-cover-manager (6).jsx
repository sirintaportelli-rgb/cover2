import { useState, useCallback, useMemo, useRef, useEffect } from "react";

// ── Storage wrapper (safe for both deployed + artifact preview) ──
const STORAGE_KEY = "coverboard_data";
function saveToStorage(data) {
  try { localStorage.setItem(STORAGE_KEY, JSON.stringify(data)); return true; }
  catch(e) { return false; }
}
function loadFromStorage() {
  try { const d = localStorage.getItem(STORAGE_KEY); return d ? JSON.parse(d) : null; }
  catch(e) { return null; }
}
function clearStorage() {
  try { localStorage.removeItem(STORAGE_KEY); } catch(e) {}
}
function getStorageSize() {
  try { const d = localStorage.getItem(STORAGE_KEY); return d ? (new Blob([d]).size / 1024).toFixed(1) : "0"; }
  catch(e) { return "?"; }
}

// ── CSV Helpers ──
function parseCSV(t){const l=t.trim().split(/\r?\n/);if(l.length<2)return{headers:[],rows:[]};const h=l[0].split(",").map(x=>x.trim().replace(/^"|"$/g,""));const r=l.slice(1).map(line=>{const v=[];let c="",q=false;for(let i=0;i<line.length;i++){if(line[i]==='"')q=!q;else if(line[i]===","&&!q){v.push(c.trim());c="";}else c+=line[i];}v.push(c.trim());return v;}).filter(r=>r.some(v=>v.length>0));return{headers:h,rows:r};}
// RFC 4180 compliant parser — handles multi-line quoted cells (needed for grid timetables)
function parseCSVMultiline(text) {
  const rows = []; let row = []; let cell = ""; let inQuotes = false;
  const chars = text.replace(/\r\n/g, "\n").replace(/\r/g, "\n");
  for (let i = 0; i < chars.length; i++) {
    const ch = chars[i];
    if (inQuotes) {
      if (ch === '"') {
        if (i + 1 < chars.length && chars[i + 1] === '"') { cell += '"'; i++; }
        else inQuotes = false;
      } else { cell += ch; }
    } else {
      if (ch === '"') { inQuotes = true; }
      else if (ch === ',') { row.push(cell); cell = ""; }
      else if (ch === '\n') { row.push(cell); cell = ""; rows.push(row); row = []; }
      else { cell += ch; }
    }
  }
  if (cell || row.length) { row.push(cell); rows.push(row); }
  return rows.filter(r => r.some(c => c.trim()));
}
function cleanText(t) {
  let s = t.replace(/^\uFEFF/, '');
  if (s.includes('\0')) s = s.replace(/\0/g, '');
  return s;
}
function mkCSV(h,r){const e=v=>{const s=String(v);return(s.includes(",")||s.includes('"')||s.includes("\n"))?`"${s.replace(/"/g,'""')}"`:s;};return[h.map(e).join(","),...r.map(x=>x.map(e).join(","))].join("\n");}
function dlCSV(f,c){const a=document.createElement("a");a.href=URL.createObjectURL(new Blob([c],{type:"text/csv"}));a.download=f;a.click();}

// ── Grid timetable detection & parsing ──
function detectFormat(text) {
  const firstLine = text.trim().split(/\r?\n/)[0] || "";
  if (/timetable\s+for\s+/i.test(firstLine)) return "grid";
  const lines = text.trim().split(/\r?\n/);
  const secondLine = (lines[1] || "").toLowerCase();
  if (/^,\s*period\s/i.test(secondLine) || /^,\s*p\d/i.test(secondLine)) return "grid";
  return "flat";
}

function parseGridTimetable(text, fallbackClassName) {
  const rows = parseCSVMultiline(text);
  if (!rows.length) return { error: "Empty file" };

  const titleRow = rows[0] || [];
  const titleText = titleRow[0] || "";
  let className = fallbackClassName || "Unknown";
  const classMatch = titleText.match(/timetable\s+for\s+(.+)/i);
  if (classMatch) className = classMatch[1].trim();

  const headerRow = rows.find(r => r.some(c => /period|^p\d/i.test(c.trim())));
  if (!headerRow) return { error: "Cannot find period headers (Period 1, Period 2, etc.)" };
  const periodHeaders = headerRow.slice(1).map((h, i) => h.trim() || `P${i + 1}`).filter(h => h);

  const timeRow = rows.find(r => r.some(c => /^\d{1,2}:\d{2}/.test(c.trim())));
  const periodTimes = {};
  if (timeRow) {
    timeRow.slice(1).forEach((t, i) => {
      if (t.trim() && i < periodHeaders.length) periodTimes[periodHeaders[i]] = t.trim();
    });
  }

  const dayPattern = /\b(monday|tuesday|wednesday|thursday|friday|saturday|sunday)\b/i;
  const dayRows = rows.filter(r => dayPattern.test((r[0] || "").trim()));
  if (!dayRows.length) return { error: "No day rows found (expected Monday, Tuesday, etc.)" };

  const teachers = new Map();
  const timetable = {};
  const dayOrder = [];
  const subjectSet = new Set();

  dayRows.forEach(row => {
    const dayName = (row[0] || "").trim();
    if (!dayOrder.includes(dayName)) dayOrder.push(dayName);

    row.slice(1).forEach((cell, colIdx) => {
      if (colIdx >= periodHeaders.length) return;
      const period = periodHeaders[colIdx];
      const cellText = cell.trim();
      if (!cellText) return;

      const lines = cellText.split('\n').map(l => l.trim()).filter(l => l);
      const entries = [];
      let i = 0;
      while (i < lines.length) {
        const line1 = lines[i] || "";
        const line3 = lines[i + 2] || "";
        if (i + 2 < lines.length && /^room\s/i.test(line3)) {
          entries.push({ teacher: line1, subject: lines[i + 1], room: line3.replace(/^room\s+/i, '') });
          i += 3;
        } else if (i + 1 < lines.length && /^room\s/i.test(lines[i + 1])) {
          entries.push({ teacher: line1, subject: "Unknown", room: lines[i + 1].replace(/^room\s+/i, '') });
          i += 2;
        } else {
          entries.push({ teacher: "", subject: line1, room: "" });
          i += 1;
        }
      }
      if (!entries.length && cellText) {
        entries.push({ teacher: "", subject: cellText, room: "" });
      }

      entries.forEach(e => {
        if (e.teacher) {
          const tKey = e.teacher.toLowerCase();
          if (!teachers.has(tKey)) teachers.set(tKey, { name: e.teacher, subjects: {}, count: 0 });
          const t = teachers.get(tKey);
          if (e.teacher.length > t.name.length) t.name = e.teacher;
          if (e.subject && e.subject !== "Unknown") t.subjects[e.subject] = (t.subjects[e.subject] || 0) + 1;
          t.count++;
        }
        if (e.subject && e.subject !== "Unknown") subjectSet.add(e.subject);
      });

      const primary = entries.find(e => e.teacher) || entries[0];
      if (!timetable[className]) timetable[className] = {};
      if (!timetable[className][dayName]) timetable[className][dayName] = {};
      timetable[className][dayName][period] = {
        teacher: primary?.teacher || "",
        subject: primary?.subject || "Free",
        room: primary?.room || "",
        allTeachers: entries.filter(e => e.teacher).map(e => ({ teacher: e.teacher, subject: e.subject, room: e.room })),
      };
    });
  });

  return { className, teachers, timetable, days: dayOrder, periods: periodHeaders, periodTimes, subjects: [...subjectSet].sort() };
}

function mergeGridResults(gridResults) {
  const allTeachers = new Map();
  const merged = { timetable: {}, days: [], periods: [], subjects: new Set(), classes: [], periodTimes: {} };
  const daySet = new Set(), periodSet = new Set();

  gridResults.forEach(gr => {
    if (gr.error) return;
    merged.classes.push(gr.className);
    Object.assign(merged.timetable, gr.timetable);
    gr.days.forEach(d => { if (!daySet.has(d)) { daySet.add(d); merged.days.push(d); } });
    gr.periods.forEach(p => { if (!periodSet.has(p)) { periodSet.add(p); merged.periods.push(p); } });
    gr.subjects.forEach(s => merged.subjects.add(s));
    Object.assign(merged.periodTimes, gr.periodTimes);
    gr.teachers.forEach((val, key) => {
      if (!allTeachers.has(key)) {
        allTeachers.set(key, { name: val.name, subjects: { ...val.subjects }, count: val.count });
      } else {
        const existing = allTeachers.get(key);
        if (val.name.length > existing.name.length) existing.name = val.name;
        Object.entries(val.subjects).forEach(([s, c]) => { existing.subjects[s] = (existing.subjects[s] || 0) + c; });
        existing.count += val.count;
      }
    });
  });

  const teacherList = [];
  let nextId = 1;
  const teacherIdByKey = new Map();
  allTeachers.forEach((entry, key) => {
    const subjectEntries = Object.entries(entry.subjects).sort((a, b) => b[1] - a[1]);
    const primarySubject = subjectEntries.length > 0 ? subjectEntries[0][0] : "General";
    const id = nextId++;
    teacherList.push({ id, name: entry.name, code: "", subject: primarySubject, lessonsPerWeek: entry.count });
    teacherIdByKey.set(key, id);
  });

  const tt = {};
  let linked = 0, total = 0;
  Object.entries(merged.timetable).forEach(([cls, days]) => {
    tt[cls] = {};
    Object.entries(days).forEach(([day, periods]) => {
      tt[cls][day] = {};
      Object.entries(periods).forEach(([period, lesson]) => {
        total++;
        const tKey = (lesson.teacher || "").toLowerCase();
        const tid = teacherIdByKey.get(tKey) || 0;
        if (tid) linked++;
        tt[cls][day][period] = { teacher: tid, subject: lesson.subject || "Free", room: lesson.room || "" };
      });
    });
  });

  return {
    teachers: teacherList, timetable: tt, days: merged.days, periods: merged.periods,
    classes: merged.classes.sort(), subjects: [...merged.subjects].sort(),
    years: [], hasYearColumn: false, hasCodeColumn: false, hasSubjectColumn: true,
    totalRows: total, linked, unlinked: total - linked, headers: ["(grid format)"],
    format: "grid", periodTimes: Object.keys(merged.periodTimes).length ? merged.periodTimes : null,
    fileCount: gridResults.filter(g => !g.error).length,
  };
}

const PALETTE=["#E8D5B7","#B7D5E8","#C5E8B7","#E8C5B7","#B7E8D5","#E8B7D5","#D5B7E8","#B7E8B7","#D5E8B7","#E8E8B7","#E8D5D5","#D5D5E8","#E8C5D5","#C5D5E8","#D5E8D5","#F0E0C0","#C0E0F0","#E0C0F0","#C0F0E0","#F0C0D0","#D0F0C0","#F0D0E0","#C0D0F0","#E0F0C0"];
function buildColorMap(subjects){const map={};subjects.forEach((s,i)=>{map[s]=PALETTE[i%PALETTE.length];});if(!map["Free"])map["Free"]="#F0F0F0";return map;}

// ── Probability ──
function poissonPMF(k,l){if(l<=0)return k===0?1:0;let r=Math.exp(-l);for(let i=1;i<=k;i++)r*=l/i;return r;}
function poissonPGTE(k,l){let s=0;for(let i=0;i<k;i++)s+=poissonPMF(i,l);return 1-s;}
function negBinCoeff(n,k){let r=1;for(let i=0;i<k;i++)r*=(n-i)/(i+1);return r;}
function negBinPMF(k,r,p){return negBinCoeff(k+r-1,k)*Math.pow(p,r)*Math.pow(1-p,k);}
function fitNegBin(m,v){if(v<=m||m<=0)return null;return{r:m*m/(v-m),p:m/v};}
function generateSampleHistory(teachers,days,weeks){const data=[];const dw={};days.forEach((d,i)=>{dw[d]=i===0?1.4:i===days.length-1?1.3:0.7+Math.random()*0.4;});for(let w=1;w<=weeks;w++){days.forEach(day=>{const lambda=1.2*(dw[day]||1);let count=0,L=Math.exp(-lambda),p=1;do{count++;p*=Math.random();}while(p>L);count--;const sh=[...teachers].sort(()=>Math.random()-0.5);for(let i=0;i<Math.min(count,sh.length);i++){data.push({teacherId:sh[i].id,day,week:w});}});}return data;}

const DEFAULT_RULES={subject_match:{enabled:false,label:"Subject-Matched Cover",desc:"Prefer teachers of the same subject",icon:"📚"},exclude_sixth_form:{enabled:false,label:"Exclude Sixth Form",desc:"Configurable classes that don't need cover",icon:"🎓",classes:[]},min_free_periods:{enabled:false,value:2,label:"Minimum Free Periods",desc:"Only use teachers with ≥N free periods that day",icon:"⏰"},exclude_covered_yesterday:{enabled:false,label:"Exclude Covered Yesterday",desc:"Don't assign teachers who covered the day before",icon:"📅"},max_capacity:{enabled:true,value:3,label:"Maximum Weekly Covers",desc:"Hard weekly cap per teacher",icon:"🛑"}};

export default function App(){
  // ── Load saved data ──
  const saved = useMemo(() => loadFromStorage(), []);
  const S = (key, fallback) => saved?.[key] ?? fallback;

  // ── School config ──
  const [setupComplete, setSetupComplete] = useState(S("setupComplete", false));
  const [schoolName, setSchoolName] = useState(S("schoolName", ""));
  const [days, setDays] = useState(S("days", []));
  const [periods, setPeriods] = useState(S("periods", []));
  const [periodTimes, setPeriodTimes] = useState(S("periodTimes", {}));
  const [subjects, setSubjects] = useState(S("subjects", []));
  const [classes, setClasses] = useState(S("classes", []));
  const [sixthFormClasses, setSixthFormClasses] = useState(S("sixthFormClasses", []));
  const [terms, setTerms] = useState(S("terms", []));
  const [teachers, setTeachers] = useState(S("teachers", []));
  const [timetable, setTimetable] = useState(S("timetable", {}));
  const [subjectColors, setSubjectColors] = useState(S("subjectColors", {}));

  // ── App state ──
  const [absences, setAbsences] = useState(S("absences", []));
  const [coverAssignments, setCoverAssignments] = useState(S("coverAssignments", {}));
  const [activeTab, setActiveTab] = useState("dashboard");
  const [selectedClass, setSelectedClass] = useState(S("selectedClass", ""));
  const [selectedTeacher, setSelectedTeacher] = useState(S("selectedTeacher", 0));
  const [viewMode, setViewMode] = useState("class");
  const [showAddTeacher, setShowAddTeacher] = useState(false);
  const [newTeacher, setNewTeacher] = useState({name:"",subject:""});
  const [showAddAbsence, setShowAddAbsence] = useState(false);
  const [newAbsence, setNewAbsence] = useState({teacherId:0,day:"",periods:[]});
  const [editingCell, setEditingCell] = useState(null);
  const [importSuccess, setImportSuccess] = useState(null);
  const [coverConstraints, setCoverConstraints] = useState(S("coverConstraints", {}));
  const [defaultMaxCovers, setDefaultMaxCovers] = useState(S("defaultMaxCovers", 3));
  const [coverHistory, setCoverHistory] = useState(S("coverHistory", []));
  const [currentWeek, setCurrentWeek] = useState(S("currentWeek", 1));
  const [currentMonth, setCurrentMonth] = useState(S("currentMonth", "September"));
  const [statsView, setStatsView] = useState("week");
  const [selectedStatWeek, setSelectedStatWeek] = useState(S("currentWeek", 1));
  const [selectedStatMonth, setSelectedStatMonth] = useState("September");
  const [selectedStatTerm, setSelectedStatTerm] = useState("");
  const [selectedSolverDay, setSelectedSolverDay] = useState(S("days", [])[0] || "");
  const [freeSolution, setFreeSolution] = useState(null);
  const [freeLog, setFreeLog] = useState([]);
  const [premiumRules, setPremiumRules] = useState(S("premiumRules", DEFAULT_RULES));
  const [premiumSolution, setPremiumSolution] = useState(null);
  const [premiumLog, setPremiumLog] = useState([]);
  const [absenceHistory, setAbsenceHistory] = useState(S("absenceHistory", []));
  const [intelSolution, setIntelSolution] = useState(null);
  const [intelLog, setIntelLog] = useState([]);
  const [reserveThreshold, setReserveThreshold] = useState(S("reserveThreshold", 3));
  const [intelForecastDay, setIntelForecastDay] = useState(S("days", [])[0] || "");
  const [optBase, setOptBase] = useState(S("optBase", 1.0));
  const [optTermWeeks, setOptTermWeeks] = useState(S("optTermWeeks", 7));
  const [optApplied, setOptApplied] = useState(false);
  const [storageOk, setStorageOk] = useState(true);
  const [lastSaved, setLastSaved] = useState(null);

  // ── Setup state ──
  const [setupTimetableRaw, setSetupTimetableRaw] = useState(null);
  const [setupGridFiles, setSetupGridFiles] = useState([]); // [{name, text}]
  const [setupFormat, setSetupFormat] = useState(null); // "flat" | "grid"
  const [setupTermsRaw, setSetupTermsRaw] = useState(null);
  const [setupPeriodTimesRaw, setSetupPeriodTimesRaw] = useState(null);
  const [setupErrors, setSetupErrors] = useState([]);
  const fileRef = useRef(null);

  // ═══ AUTO-SAVE ═══
  useEffect(() => {
    // Don't save if setup not complete (nothing worth saving yet)
    if (!setupComplete && !coverHistory.length) return;
    const data = {
      setupComplete, schoolName, days, periods, periodTimes, subjects, classes,
      sixthFormClasses, terms, teachers, timetable, subjectColors,
      absences, coverAssignments, coverConstraints, defaultMaxCovers,
      coverHistory, currentWeek, currentMonth, premiumRules, absenceHistory,
      reserveThreshold, optBase, optTermWeeks, selectedClass, selectedTeacher,
    };
    const ok = saveToStorage(data);
    setStorageOk(ok);
    if (ok) setLastSaved(new Date());
  }, [
    setupComplete, schoolName, days, periods, periodTimes, subjects, classes,
    sixthFormClasses, terms, teachers, timetable, subjectColors,
    absences, coverAssignments, coverConstraints, defaultMaxCovers,
    coverHistory, currentWeek, currentMonth, premiumRules, absenceHistory,
    reserveThreshold, optBase, optTermWeeks, selectedClass, selectedTeacher,
  ]);

  const resetAllData = () => {
    if (!window.confirm("This will permanently delete ALL school data, cover history, and settings. Are you sure?")) return;
    clearStorage();
    // Reset everything
    setSetupComplete(false); setSchoolName(""); setDays([]); setPeriods([]);
    setPeriodTimes({}); setSubjects([]); setClasses([]); setSixthFormClasses([]);
    setTerms([]); setTeachers([]); setTimetable({}); setSubjectColors({});
    setAbsences([]); setCoverAssignments({}); setCoverConstraints({});
    setDefaultMaxCovers(3); setCoverHistory([]); setCurrentWeek(1);
    setCurrentMonth("September"); setPremiumRules(DEFAULT_RULES);
    setAbsenceHistory([]); setReserveThreshold(3); setOptBase(1.0); setOptTermWeeks(7);
    setImportSuccess("All data cleared."); setTimeout(() => setImportSuccess(null), 3000);
  };

  // ── Core helpers ──
  const gt = useCallback(id=>teachers.find(t=>t.id===id),[teachers]);
  const gmc = useCallback(tid=>coverConstraints[tid]??defaultMaxCovers,[coverConstraints,defaultMaxCovers]);
  const gwc = useCallback((tid,w)=>coverHistory.filter(h=>h.teacherId===tid&&h.week===w).length,[coverHistory]);
  const gMonC = useCallback((tid,m)=>coverHistory.filter(h=>h.teacherId===tid&&h.month===m).length,[coverHistory]);
  const gTermC = useCallback((tid,tn)=>{const t=terms.find(x=>x.name===tn);return t?coverHistory.filter(h=>h.teacherId===tid&&h.week>=t.startWeek&&h.week<=t.endWeek).length:coverHistory.filter(h=>h.teacherId===tid&&h.term===tn).length;},[coverHistory,terms]);
  const curTerm = useCallback(()=>{if(!terms.length)return`Week ${currentWeek}`;const t=terms.find(t=>currentWeek>=t.startWeek&&currentWeek<=t.endWeek);return t?.name||`Week ${currentWeek}`;},[currentWeek,terms]);
  const getFreePeriods = useCallback((tid,day)=>{let f=0;periods.forEach(p=>{let busy=false;classes.forEach(c=>{const l=timetable[c]?.[day]?.[p];if(l&&l.teacher===tid)busy=true;});if(!busy)f++;});return f;},[timetable,periods,classes]);
  const didCoverOnDay = useCallback((tid,day)=>coverHistory.some(h=>h.teacherId===tid&&h.day===day&&h.week===currentWeek),[coverHistory,currentWeek]);
  const getWeeklyFreeProfile = useCallback(tid=>{const p={};days.forEach(d=>{p[d]=getFreePeriods(tid,d);});return p;},[getFreePeriods,days]);
  const getRawFreeIds = useCallback((day,period)=>{const busy=new Set();classes.forEach(c=>{const l=timetable[c]?.[day]?.[period];if(l)busy.add(l.teacher);});const absent=new Set(absences.filter(a=>a.day===day&&a.periods.includes(period)).map(a=>a.teacherId));return teachers.filter(t=>(!busy.has(t.id)||absent.has(t.id))&&!absent.has(t.id)).map(t=>t.id);},[teachers,timetable,absences,classes]);

  const uncoveredLessons = useMemo(()=>{const u=[];absences.forEach(a=>{a.periods.forEach(p=>{classes.forEach(c=>{const l=timetable[c]?.[a.day]?.[p];if(l&&l.teacher===a.teacherId&&!coverAssignments[`${a.day}-${p}-${c}`])u.push({day:a.day,period:p,class:c,lesson:l});});});});return u;},[absences,timetable,coverAssignments,classes]);
  const coveredLessons = useMemo(()=>Object.entries(coverAssignments).map(([k,cid])=>{const[d,p,...rest]=k.split("-");return{key:k,day:d,period:p,class:rest.join("-"),coverTeacherId:cid};}),[coverAssignments]);

  const getFreeTeachers = useCallback((day,period)=>{
    const busy=new Set();classes.forEach(c=>{const l=timetable[c]?.[day]?.[period];if(l)busy.add(l.teacher);});
    const absent=new Set(absences.filter(a=>a.day===day&&a.periods.includes(period)).map(a=>a.teacherId));
    const covering=new Set(Object.entries(coverAssignments).filter(([k])=>k.startsWith(`${day}-${period}-`)).map(([,v])=>v));
    return teachers.filter(t=>(!busy.has(t.id)||absent.has(t.id))&&!absent.has(t.id)&&!covering.has(t.id)).map(t=>{const wc=gwc(t.id,currentWeek),mc=gmc(t.id);return{...t,weeklyCount:wc,maxCovers:mc,atLimit:wc>=mc};});
  },[teachers,timetable,absences,coverAssignments,gwc,currentWeek,gmc,classes]);

  const assignCover=(d,p,c,tid)=>{setCoverAssignments(prev=>({...prev,[`${d}-${p}-${c}`]:tid}));setCoverHistory(prev=>[...prev,{teacherId:tid,day:d,period:p,class:c,week:currentWeek,month:currentMonth,term:curTerm(),timestamp:Date.now()}]);};
  const removeCover=(k)=>{const[d,p,...rest]=k.split("-");const c=rest.join("-");const cid=coverAssignments[k];setCoverAssignments(prev=>{const n={...prev};delete n[k];return n;});setCoverHistory(prev=>{const idx=prev.findLastIndex(h=>h.teacherId===cid&&h.day===d&&h.period===p&&h.class===c&&h.week===currentWeek);if(idx!==-1){const n=[...prev];n.splice(idx,1);return n;}return prev;});};
  const addTeacher=()=>{if(!newTeacher.name.trim())return;const id=Math.max(0,...teachers.map(t=>t.id))+1;const t={id,...newTeacher};setTeachers(p=>[...p,t]);if(newTeacher.subject&&!subjects.includes(newTeacher.subject)){setSubjects(p=>[...p,newTeacher.subject]);setSubjectColors(prev=>({...prev,[newTeacher.subject]:PALETTE[Object.keys(prev).length%PALETTE.length]}));}setNewTeacher({name:"",subject:subjects[0]||""});setShowAddTeacher(false);};
  const addAbsence=()=>{if(!newAbsence.periods.length)return;setAbsences(p=>[...p,{...newAbsence,id:Date.now()}]);setNewAbsence({teacherId:teachers[0]?.id||0,day:days[0]||"",periods:[]});setShowAddAbsence(false);};
  const removeAbsence=(id)=>{const a=absences.find(x=>x.id===id);if(a){setCoverAssignments(prev=>{const n={...prev};Object.keys(n).forEach(k=>{const[d,p]=k.split("-");if(d===a.day&&a.periods.includes(p))delete n[k];});return n;});}setAbsences(p=>p.filter(x=>x.id!==id));};

  // ═══ SETUP ═══
  // ═══ SINGLE-FILE SMART PARSER ═══
  // Extracts teachers, subjects, days, periods, classes — everything from one timetable CSV
  const processAllFromTimetable = (text) => {
    const {headers, rows} = parseCSV(text);
    const ci=headers.findIndex(h=>h.toLowerCase().includes("class")||h.toLowerCase().includes("group")||h.toLowerCase().includes("form"));
    const di=headers.findIndex(h=>h.toLowerCase().includes("day"));
    const pi=headers.findIndex(h=>h.toLowerCase().includes("period")||h.toLowerCase().includes("lesson"));
    const si=headers.findIndex(h=>h.toLowerCase().includes("subject")||h.toLowerCase().includes("course"));
    const ri=headers.findIndex(h=>h.toLowerCase().includes("room"));
    // Teacher name column
    let ti=headers.findIndex(h=>{const l=h.toLowerCase();return(l.includes("teacher")||l.includes("staff"))&&!l.includes("code")&&!l.includes("id")&&!l.includes("initial");});
    // Teacher code column
    const tci=headers.findIndex(h=>{const l=h.toLowerCase();return l.includes("code")||l==="id"||l==="staff id"||l==="staff_id"||l==="initials"||l==="abbr";});
    // Year group column (optional — for filtering)
    const yi=headers.findIndex(h=>{const l=h.toLowerCase();return l.includes("year")||l.includes("yr")||l.includes("key stage")||l.includes("ks");});

    const missing=[];
    if(ci===-1)missing.push("Class/Group/Form");
    if(di===-1)missing.push("Day");
    if(pi===-1)missing.push("Period/Lesson");
    if(ti===-1&&tci===-1)missing.push("Teacher/Staff or Code");
    if(missing.length)return{error:`Missing columns: ${missing.join(", ")}. Found: ${headers.join(", ")}`};

    // First pass: collect all unique teacher identifiers and their subject counts
    const teacherMap = new Map(); // key (name or code) → {name, code, subjects:{}}
    const daySet=new Set(),periodSet=new Set(),classSet=new Set(),subjectSet=new Set(),yearSet=new Set();
    const dayOrder=[],periodOrder=[],classOrder=[];

    rows.forEach(r => {
      const cls=(r[ci]||"").trim();
      const day=(r[di]||"").trim();
      const period=(r[pi]||"").trim();
      const subject=si!==-1?(r[si]||"").trim():"";
      const tName=ti!==-1?(r[ti]||"").trim():"";
      const tCode=tci!==-1?(r[tci]||"").trim():"";
      const year=yi!==-1?(r[yi]||"").trim():"";

      if(!cls||!day||!period)return;
      if(!daySet.has(day)){daySet.add(day);dayOrder.push(day);}
      if(!periodSet.has(period)){periodSet.add(period);periodOrder.push(period);}
      if(!classSet.has(cls)){classSet.add(cls);classOrder.push(cls);}
      if(subject&&subject.toLowerCase()!=="free"&&subject.toLowerCase()!=="none")subjectSet.add(subject);
      if(year)yearSet.add(year);

      // Build teacher identity
      const key = (tCode || tName).toLowerCase();
      if(!key)return;
      if(!teacherMap.has(key)){
        teacherMap.set(key, {name:tName||tCode, code:tCode, subjects:{}, count:0});
      }
      const entry = teacherMap.get(key);
      // Keep longest/most complete name variant
      if(tName && tName.length > entry.name.length) entry.name = tName;
      if(tCode && !entry.code) entry.code = tCode;
      if(subject && subject.toLowerCase()!=="free" && subject.toLowerCase()!=="none"){
        entry.subjects[subject] = (entry.subjects[subject]||0) + 1;
      }
      entry.count++;
    });

    // Build teacher list: assign ID, determine primary subject from most-taught
    const teacherList = [];
    let nextId = 1;
    teacherMap.forEach((entry, key) => {
      const subjectEntries = Object.entries(entry.subjects).sort((a,b) => b[1] - a[1]);
      const primarySubject = subjectEntries.length > 0 ? subjectEntries[0][0] : "General";
      teacherList.push({
        id: nextId++,
        name: entry.name,
        code: entry.code || "",
        subject: primarySubject,
        lessonsPerWeek: entry.count,
      });
    });

    // Build lookup maps for timetable construction
    const byCode={},byName={};
    teacherList.forEach(t => {
      if(t.code) byCode[t.code.toLowerCase()] = t;
      byName[t.name.toLowerCase()] = t;
    });

    // Second pass: build timetable structure
    const tt = {};
    let linked = 0;
    rows.forEach(r => {
      const cls=(r[ci]||"").trim();
      const day=(r[di]||"").trim();
      const period=(r[pi]||"").trim();
      const subject=si!==-1?(r[si]||"").trim():"";
      const tName=ti!==-1?(r[ti]||"").trim():"";
      const tCode=tci!==-1?(r[tci]||"").trim():"";
      const room=ri!==-1?(r[ri]||"").trim():"";
      if(!cls||!day||!period)return;

      // Find teacher
      const key = (tCode||tName).toLowerCase();
      const tm = (tCode && byCode[tCode.toLowerCase()]) || (tName && byName[tName.toLowerCase()]) || null;
      if(tm) linked++;

      if(!tt[cls])tt[cls]={};
      if(!tt[cls][day])tt[cls][day]={};
      tt[cls][day][period] = {teacher:tm?tm.id:0, subject:subject||"Free", room:room||""};
    });

    const allSubjects = [...subjectSet].sort();
    const years = [...yearSet].sort();

    return {
      teachers: teacherList,
      timetable: tt,
      days: dayOrder,
      periods: periodOrder,
      classes: classOrder,
      subjects: allSubjects,
      years: years,
      hasYearColumn: yi !== -1,
      hasCodeColumn: tci !== -1,
      hasSubjectColumn: si !== -1,
      totalRows: rows.length,
      linked,
      unlinked: rows.length - linked,
      headers,
    };
  };

  const processTermsCSV=(text)=>{const{headers,rows}=parseCSV(text);const ni=headers.findIndex(h=>h.toLowerCase().includes("name")||h.toLowerCase().includes("term"));const si=headers.findIndex(h=>h.toLowerCase().includes("start"));const ei=headers.findIndex(h=>h.toLowerCase().includes("end"));if(ni===-1||si===-1||ei===-1)return{error:"Needs: Term/Name, Start Week, End Week"};return{terms:rows.map(r=>({name:(r[ni]||"").trim(),startWeek:parseInt(r[si])||1,endWeek:parseInt(r[ei])||1})).filter(t=>t.name)};};
  const processPeriodTimesCSV=(text)=>{const{headers,rows}=parseCSV(text);const pi=headers.findIndex(h=>h.toLowerCase().includes("period"));const si=headers.findIndex(h=>h.toLowerCase().includes("start"));const ei=headers.findIndex(h=>h.toLowerCase().includes("end"));if(pi===-1)return{error:"Needs a 'Period' column"};const times={};rows.forEach(r=>{const p=(r[pi]||"").trim();const start=si!==-1?(r[si]||"").trim():"";const end=ei!==-1?(r[ei]||"").trim():"";if(p)times[p]=start&&end?`${start}–${end}`:start||"";});return{periodTimes:times};};
  const handleSetupFile=(type)=>(e)=>{const files=Array.from(e.target.files||[]);if(!files.length)return;if(type==="timetable"){
    // Read all selected files
    const readers=files.map(f=>new Promise((resolve)=>{const r=new FileReader();r.onload=(ev)=>{const raw=cleanText(ev.target.result);resolve({name:f.name,text:raw});};r.onerror=()=>resolve({name:f.name,text:"",error:true});r.readAsText(f);}));
    Promise.all(readers).then(results=>{
      const validFiles=results.filter(r=>r.text.trim());
      if(!validFiles.length){setSetupErrors(["All files appear empty or corrupted."]);return;}
      // Auto-detect format from first valid file
      const fmt=detectFormat(validFiles[0].text);
      setSetupFormat(fmt);
      if(fmt==="grid"){setSetupGridFiles(validFiles);setSetupTimetableRaw(null);}
      else{setSetupTimetableRaw(validFiles[0].text);setSetupGridFiles([]);}
      setSetupErrors([]);
    });
  } else if(type==="terms"){const r=new FileReader();r.onload=(ev)=>{setSetupTermsRaw(cleanText(ev.target.result));setSetupErrors([]);};r.readAsText(files[0]);}
  else if(type==="periodTimes"){const r=new FileReader();r.onload=(ev)=>{setSetupPeriodTimesRaw(cleanText(ev.target.result));setSetupErrors([]);};r.readAsText(files[0]);}
  e.target.value="";};
  const mainParsed=useMemo(()=>{
    if(setupFormat==="grid"&&setupGridFiles.length){
      const gridResults=setupGridFiles.map(f=>{const fn=f.name.replace(/\.[^.]+$/,"").replace(/_xlsx_.*|_csv.*/i,"");return parseGridTimetable(f.text,fn);});
      const errors=gridResults.filter(g=>g.error);
      if(errors.length===gridResults.length)return{error:errors[0].error};
      const merged=mergeGridResults(gridResults);
      if(errors.length)merged.warnings=errors.map(e=>`${e.error}`);
      return merged;
    }
    if(setupTimetableRaw)return processAllFromTimetable(setupTimetableRaw);
    return null;
  },[setupTimetableRaw,setupGridFiles,setupFormat]);
  const termsParsed=useMemo(()=>setupTermsRaw?processTermsCSV(setupTermsRaw):null,[setupTermsRaw]);
  const periodTimesParsed=useMemo(()=>setupPeriodTimesRaw?processPeriodTimesCSV(setupPeriodTimesRaw):null,[setupPeriodTimesRaw]);

  const finaliseSetup=()=>{if(!mainParsed?.teachers?.length||!mainParsed?.timetable)return;setTeachers(mainParsed.teachers);setTimetable(mainParsed.timetable);setDays(mainParsed.days);setPeriods(mainParsed.periods);setClasses(mainParsed.classes);setSubjects(mainParsed.subjects);setSubjectColors(buildColorMap(mainParsed.subjects));if(termsParsed?.terms)setTerms(termsParsed.terms);
    // Period times: prefer uploaded CSV, fall back to grid-detected times
    if(periodTimesParsed?.periodTimes)setPeriodTimes(periodTimesParsed.periodTimes);
    else if(mainParsed.periodTimes)setPeriodTimes(mainParsed.periodTimes);
    setSelectedClass(mainParsed.classes[0]||"");setSelectedTeacher(mainParsed.teachers[0]?.id||0);setSelectedSolverDay(mainParsed.days[0]||"");setIntelForecastDay(mainParsed.days[0]||"");setNewAbsence({teacherId:mainParsed.teachers[0]?.id||0,day:mainParsed.days[0]||"",periods:[]});setNewTeacher({name:"",subject:mainParsed.subjects[0]||""});setAbsenceHistory(generateSampleHistory(mainParsed.teachers,mainParsed.days,Math.min(currentWeek,14)));setSetupComplete(true);};

  // ═══ SOLVERS ═══
  const getLessonsForDay=useCallback((day)=>{const lessons=[];absences.forEach(abs=>{if(abs.day!==day)return;abs.periods.forEach(period=>{classes.forEach(cls=>{const l=timetable[cls]?.[day]?.[period];if(l&&l.teacher===abs.teacherId&&!coverAssignments[`${day}-${period}-${cls}`])lessons.push({day,period,class:cls,lesson:l,subject:l.subject,key:`${day}-${period}-${cls}`});});});});return lessons;},[absences,timetable,coverAssignments,classes]);
  const getCandidates=useCallback((day,period,tempAssigned)=>{const busy=new Set();classes.forEach(c=>{const l=timetable[c]?.[day]?.[period];if(l)busy.add(l.teacher);});const absent=new Set(absences.filter(a=>a.day===day&&a.periods.includes(period)).map(a=>a.teacherId));const already=tempAssigned[period]||new Set();return teachers.filter(t=>(!busy.has(t.id)||absent.has(t.id))&&!absent.has(t.id)&&!already.has(t.id));},[teachers,timetable,absences,classes]);

  // ── Pre-analysis engine ──
  const analyseDay = useCallback((day, lessons, log, rules) => {
    const absentIds = new Set(absences.filter(a=>a.day===day).map(a=>a.teacherId));
    // Per-period: who is free AND not absent AND not teaching
    const periodAvail = {}, periodNeeded = {};
    const byPeriod = {};
    lessons.forEach(l => { if(!byPeriod[l.period]) byPeriod[l.period] = []; byPeriod[l.period].push(l); });

    // Get raw availability per period (no weekly cap filter — that's solver logic)
    const usedPeriods = [...new Set(lessons.map(l=>l.period))];
    usedPeriods.forEach(p => {
      const busy = new Set();
      classes.forEach(c => { const l = timetable[c]?.[day]?.[p]; if(l) busy.add(l.teacher); });
      const avail = teachers.filter(t => (!busy.has(t.id) || absentIds.has(t.id)) && !absentIds.has(t.id));
      periodAvail[p] = avail.map(t => t.id);
      periodNeeded[p] = (byPeriod[p] || []).length;
    });

    // Build cross-period teacher usage map: which periods each teacher is available
    const teacherPeriods = {};
    teachers.forEach(t => { teacherPeriods[t.id] = []; });
    usedPeriods.forEach(p => { periodAvail[p].forEach(tid => { if(teacherPeriods[tid]) teacherPeriods[tid].push(p); }); });

    // Total unique teacher-slots available (each teacher can cover 1 lesson per period they're free)
    const totalSlots = Object.values(periodAvail).reduce((a, ids) => a + ids.length, 0);
    const totalNeeded = lessons.length;

    // Identify impossible periods: more lessons than available teachers
    const impossiblePeriods = {}, tightPeriods = {}, okPeriods = {};
    let guaranteedShortfall = 0;
    usedPeriods.forEach(p => {
      const avail = periodAvail[p].length;
      const need = periodNeeded[p];
      const surplus = avail - need;
      if (surplus < 0) {
        impossiblePeriods[p] = { available: avail, needed: need, shortfall: -surplus };
        guaranteedShortfall += -surplus;
      } else if (surplus < 2) {
        tightPeriods[p] = { available: avail, needed: need, surplus };
      } else {
        okPeriods[p] = { available: avail, needed: need, surplus };
      }
    });

    // Cross-period constraint check: teacher only free in ONE period that has lessons
    // These are "pinned" teachers — must be used in that period or it's wasted
    const pinned = [];
    Object.values(teacherPeriods).forEach((pds) => {
      // Filter to only periods that actually need cover
      const relevantPds = pds.filter(p => periodNeeded[p] > 0);
      if (relevantPds.length === 1) {
        const p = relevantPds[0];
        const tid = Object.keys(teacherPeriods).find(id => teacherPeriods[id] === pds);
        // This teacher can only help in one period
        pinned.push({ period: p });
      }
    });

    // Best-case: even with perfect allocation, how many can't be covered?
    // Use greedy matching: sort periods by scarcity (fewest available first)
    const sortedPeriods = [...usedPeriods].sort((a, b) => (periodAvail[a].length - periodNeeded[a]) - (periodAvail[b].length - periodNeeded[b]));
    const simUsed = new Set();
    let simAssigned = 0;
    sortedPeriods.forEach(p => {
      const avail = periodAvail[p].filter(id => !simUsed.has(id));
      const need = periodNeeded[p];
      const canDo = Math.min(avail.length, need);
      avail.slice(0, canDo).forEach(id => simUsed.add(id));
      simAssigned += canDo;
    });
    const bestCaseUnresolved = totalNeeded - simAssigned;

    // Status
    const status = bestCaseUnresolved === 0 ? "solvable" : guaranteedShortfall > 0 ? "impossible" : "constrained";

    // Logging
    log.push({t:"h",m:"\n🔍 PRE-ANALYSIS"});
    log.push({t:"i",m:`${totalNeeded} lessons need cover, ${Object.values(periodAvail).reduce((a,v)=>{ const s=new Set(a.ids||[]); v.forEach(id=>s.add(id)); return{ids:[...s],count:s.size};},{ids:[],count:0}).count} unique teachers available`});

    if (status === "impossible") {
      log.push({t:"f",m:`🚫 IMPOSSIBLE: ${guaranteedShortfall} lesson${guaranteedShortfall>1?"s":""} cannot be covered (not enough free teachers)`});
      Object.entries(impossiblePeriods).forEach(([p,v]) => {
        log.push({t:"f",m:`   ${p}: need ${v.needed}, only ${v.available} free → ${v.shortfall} unfillable`});
      });
      log.push({t:"w",m:`Best case: ${simAssigned}/${totalNeeded} covered, ${bestCaseUnresolved} unresolved`});
    } else if (status === "constrained") {
      log.push({t:"w",m:`⚠ TIGHT: all periods have enough teachers individually, but cross-period constraints mean ${bestCaseUnresolved} will likely be unresolved`});
    } else {
      log.push({t:"s",m:`✅ Solvable: enough capacity for all ${totalNeeded} lessons`});
    }

    if (Object.keys(tightPeriods).length > 0) {
      log.push({t:"w",m:`Tight periods: ${Object.entries(tightPeriods).map(([p,v])=>`${p} (${v.available} avail, ${v.needed} need)`).join(", ")}`});
    }

    // Sort lessons: scarce periods first, then by fewest available teachers
    const sortedLessons = [...lessons].sort((a, b) => {
      const aS = (periodAvail[a.period]?.length || 0) - (periodNeeded[a.period] || 0);
      const bS = (periodAvail[b.period]?.length || 0) - (periodNeeded[b.period] || 0);
      return aS - bS; // Most constrained first
    });

    return {
      status, totalNeeded, totalSlots, bestCaseUnresolved, guaranteedShortfall,
      impossiblePeriods, tightPeriods, okPeriods, periodAvail, periodNeeded,
      sortedLessons, sortedPeriods, byPeriod
    };
  }, [absences, teachers, timetable, classes]);

  // Free
  const runFreeSolver=useCallback(()=>{const log=[],day=selectedSolverDay;log.push({t:"h",m:`📋 FREE SOLVER — ${day}`});const lessons=getLessonsForDay(day);log.push({t:"i",m:`${lessons.length} lessons`});if(!lessons.length){log.push({t:"s",m:"✅ None!"});setFreeSolution({day,assignments:[],unresolved:[],analysis:null});setFreeLog(log);return;}
    const analysis = analyseDay(day, lessons, log, null);
    log.push({t:"h",m:"\n⚡ ASSIGNMENT"});
    const tA={},tW={};teachers.forEach(t=>{tW[t.id]=gwc(t.id,currentWeek);});const asgn=[],unr=[];
    analysis.sortedLessons.forEach(lesson=>{let c=getCandidates(day,lesson.period,tA);c=c.filter(t=>(tW[t.id]||0)<gmc(t.id));c=c.map(t=>({...t,score:100-(tW[t.id]||0)*10})).sort((a,b)=>b.score-a.score);if(c.length>0){const ch=c[0];asgn.push({...lesson,coverTeacherId:ch.id,coverTeacherName:ch.name,coverTeacherSubject:ch.subject,score:ch.score});if(!tA[lesson.period])tA[lesson.period]=new Set();tA[lesson.period].add(ch.id);tW[ch.id]=(tW[ch.id]||0)+1;log.push({t:"s",m:`✅ ${lesson.period} ${lesson.class} (${lesson.subject}) → ${ch.name}`});}else{unr.push(lesson);log.push({t:"f",m:`❌ ${lesson.period} ${lesson.class} — no candidates`});}});
    log.push({t:"h",m:`\n📊 ${asgn.length} assigned, ${unr.length} unresolved`});
    if(unr.length>0&&analysis.status==="impossible")log.push({t:"w",m:`ℹ Pre-analysis predicted ${analysis.bestCaseUnresolved} minimum unresolved`});
    setFreeSolution({day,assignments:asgn,unresolved:unr,analysis});setFreeLog(log);},[selectedSolverDay,getLessonsForDay,getCandidates,gwc,gmc,currentWeek,teachers,analyseDay]);

  // Premium
  const runPremiumSolver=useCallback(()=>{const log=[],day=selectedSolverDay,rules=premiumRules;log.push({t:"h",m:`⚡ PREMIUM — ${day}`});log.push({t:"i",m:`Rules: ${Object.entries(rules).filter(([,r])=>r.enabled).map(([,r])=>r.label).join(", ")||"None"}`});let lessons=getLessonsForDay(day);if(rules.exclude_sixth_form?.enabled&&sixthFormClasses.length){const b=lessons.length;lessons=lessons.filter(l=>!sixthFormClasses.includes(l.class));if(b-lessons.length>0)log.push({t:"r",m:`🎓 Excluded ${b-lessons.length} sixth form`});}log.push({t:"i",m:`${lessons.length} lessons`});if(!lessons.length){log.push({t:"s",m:"✅ None!"});setPremiumSolution({day,assignments:[],unresolved:[],analysis:null});setPremiumLog(log);return;}
    const analysis = analyseDay(day, lessons, log, rules);
    log.push({t:"h",m:"\n⚡ ASSIGNMENT"});
    const tA={},tW={};teachers.forEach(t=>{tW[t.id]=gwc(t.id,currentWeek);});const asgn=[],unr=[];const prev=days.indexOf(day)>0?days[days.indexOf(day)-1]:null;
    analysis.sortedLessons.forEach(lesson=>{let c=getCandidates(day,lesson.period,tA);const fl=[];if(rules.max_capacity?.enabled){const b=c.length;c=c.filter(t=>(tW[t.id]||0)<(rules.max_capacity.value||3));if(b-c.length>0)fl.push(`${b-c.length} at cap`);}if(rules.min_free_periods?.enabled){const mf=rules.min_free_periods.value||2;const b=c.length;c=c.filter(t=>getFreePeriods(t.id,day)>=mf);if(b-c.length>0)fl.push(`${b-c.length} <${mf} frees`);}if(rules.exclude_covered_yesterday?.enabled&&prev){const b=c.length;c=c.filter(t=>!didCoverOnDay(t.id,prev));if(b-c.length>0)fl.push(`${b-c.length} yesterday`);}c=c.map(t=>{let s=50;if(rules.subject_match?.enabled&&t.subject===lesson.subject)s+=30;s-=(tW[t.id]||0)*5;s+=getFreePeriods(t.id,day)*2;return{...t,score:Math.round(s)};}).sort((a,b)=>b.score-a.score);if(c.length>0){const ch=c[0];const isM=rules.subject_match?.enabled&&ch.subject===lesson.subject;asgn.push({...lesson,coverTeacherId:ch.id,coverTeacherName:ch.name,coverTeacherSubject:ch.subject,score:ch.score,isSubjectMatch:isM});if(!tA[lesson.period])tA[lesson.period]=new Set();tA[lesson.period].add(ch.id);tW[ch.id]=(tW[ch.id]||0)+1;log.push({t:"s",m:`✅ ${lesson.period} ${lesson.class} → ${ch.name}${isM?" 📚":""} [${ch.score}]`});if(fl.length)log.push({t:"d",m:`   ${fl.join(", ")}`});}else{unr.push(lesson);log.push({t:"f",m:`❌ ${lesson.period} ${lesson.class} [${fl.join(", ")}]`});}});
    log.push({t:"h",m:`\n📊 ${asgn.length} assigned, ${unr.length} unresolved`});
    if(unr.length>0&&analysis.status==="impossible")log.push({t:"w",m:`ℹ Pre-analysis predicted ${analysis.bestCaseUnresolved} minimum unresolved`});
    setPremiumSolution({day,assignments:asgn,unresolved:unr,analysis});setPremiumLog(log);},[selectedSolverDay,getLessonsForDay,getCandidates,premiumRules,gwc,gmc,currentWeek,teachers,getFreePeriods,didCoverOnDay,days,sixthFormClasses,analyseDay]);

  // Intelligence
  const absenceStats=useMemo(()=>{const stats={};days.forEach(day=>{const counts=[];const weeks={};absenceHistory.filter(h=>h.day===day).forEach(h=>{if(!weeks[h.week])weeks[h.week]=new Set();weeks[h.week].add(h.teacherId);});const maxW=absenceHistory.length>0?Math.max(...absenceHistory.map(h=>h.week)):currentWeek;for(let w=1;w<=maxW;w++)counts.push(weeks[w]?weeks[w].size:0);if(!counts.length)counts.push(0);const mean=counts.reduce((a,b)=>a+b,0)/counts.length;const variance=counts.reduce((a,b)=>a+(b-mean)**2,0)/Math.max(counts.length-1,1);stats[day]={mean,variance,nb:fitNegBin(mean,variance),weeks:counts.length};});return stats;},[absenceHistory,currentWeek,days]);
  const forecast=useMemo(()=>{const fc={};days.forEach(day=>{const s=absenceStats[day];if(!s){fc[day]={probs:[{k:0,prob:1}],mean:0,model:"—",variance:0,dataPoints:0};return;}const probs=[];for(let k=0;k<=10;k++)probs.push({k,prob:s.nb&&s.variance>s.mean?negBinPMF(k,s.nb.r,s.nb.p):poissonPMF(k,s.mean)});fc[day]={probs,mean:s.mean,model:s.nb&&s.variance>s.mean?"Neg.Bin":"Poisson",variance:s.variance,dataPoints:s.weeks};});return fc;},[absenceStats,days]);

  const runIntelligentSolver=useCallback(()=>{const log=[],day=selectedSolverDay,rules=premiumRules,fc=forecast[day];log.push({t:"h",m:`🧠 INTELLIGENT — ${day}`});if(fc)log.push({t:"i",m:`Forecast: ${fc.mean.toFixed(1)} (${fc.model})`});let lessons=getLessonsForDay(day);if(rules.exclude_sixth_form?.enabled&&sixthFormClasses.length){const b=lessons.length;lessons=lessons.filter(l=>!sixthFormClasses.includes(l.class));if(b-lessons.length>0)log.push({t:"r",m:`🎓 Excluded ${b-lessons.length}`});}log.push({t:"i",m:`${lessons.length} lessons`});if(!lessons.length){log.push({t:"s",m:"✅ None!"});setIntelSolution({day,assignments:[],unresolved:[],reserved:[],scarcePeriods:{},forecast:fc,analysis:null});setIntelLog(log);return;}
    const analysis = analyseDay(day, lessons, log, rules);
    log.push({t:"h",m:"\n📐 Availability"});const allAbsent=new Set(absences.filter(a=>a.day===day).map(a=>a.teacherId));const pAvail={};periods.forEach(p=>{pAvail[p]=getRawFreeIds(day,p).filter(id=>!allAbsent.has(id));});const byP=analysis.byPeriod;
    log.push({t:"h",m:"\n🔒 Reserves"});const scarce={},reserved=new Set(),rMap={};periods.forEach(p=>{const av=pAvail[p]?.length||0,nd=byP[p]?.length||0,su=av-nd;if(nd>0&&su<reserveThreshold){scarce[p]={available:av,needed:nd,surplus:su};log.push({t:"w",m:`⚠ ${p}: ${av} free, ${nd} needed`});pAvail[p]?.forEach(tid=>{reserved.add(tid);if(!rMap[tid])rMap[tid]=[];rMap[tid].push(p);});}});if(reserved.size)log.push({t:"r",m:`🔒 ${[...reserved].map(id=>gt(id)?.name).join(", ")}`});
    log.push({t:"h",m:"\n🎯 Strategy"});const profiles={};teachers.forEach(t=>{const wp=getWeeklyFreeProfile(t.id),total=Object.values(wp).reduce((a,b)=>a+b,0),today=wp[day]||0;const remaining=days.slice(days.indexOf(day)+1).reduce((a,d)=>a+(wp[d]||0),0);let vl=0;days.slice(days.indexOf(day)+1).forEach(fd=>{periods.forEach(p=>{let isFree=true;classes.forEach(c=>{const l=timetable[c]?.[fd]?.[p];if(l&&l.teacher===t.id)isFree=false;});if(isFree){let others=0;teachers.forEach(o=>{if(o.id===t.id)return;let of2=true;classes.forEach(c=>{const l=timetable[c]?.[fd]?.[p];if(l&&l.teacher===o.id)of2=false;});if(of2)others++;});if(others<4)vl+=(4-others);}});});profiles[t.id]={today,remaining,total,concentration:total>0?today/total:0,valueLater:vl};});
    log.push({t:"h",m:"\n⚡ Assignment (scarcity-first)"});
    const tA={},tW={};teachers.forEach(t=>{tW[t.id]=gwc(t.id,currentWeek);});const asgn=[],unr=[];const prev=days.indexOf(day)>0?days[days.indexOf(day)-1]:null;
    analysis.sortedLessons.forEach(lesson=>{let c=getCandidates(day,lesson.period,tA);const fl=[];if(rules.max_capacity?.enabled){const b=c.length;c=c.filter(t=>(tW[t.id]||0)<(rules.max_capacity.value||3));if(b-c.length>0)fl.push(`${b-c.length} cap`);}if(rules.min_free_periods?.enabled){const mf=rules.min_free_periods.value||2;const b=c.length;c=c.filter(t=>getFreePeriods(t.id,day)>=mf);if(b-c.length>0)fl.push(`${b-c.length} frees`);}if(rules.exclude_covered_yesterday?.enabled&&prev){const b=c.length;c=c.filter(t=>!didCoverOnDay(t.id,prev));if(b-c.length>0)fl.push(`${b-c.length} yest`);}if(!scarce[lesson.period]){const b=c.length;c=c.filter(t=>!reserved.has(t.id)||(rMap[t.id]||[]).includes(lesson.period));if(b-c.length>0)fl.push(`${b-c.length} rsv`);}c=c.map(t=>{const pr=profiles[t.id];let s=50;if(rules.subject_match?.enabled&&t.subject===lesson.subject)s+=30;s-=(tW[t.id]||0)*8;s+=(pr.concentration*20);s-=(pr.valueLater*1.5);if(pr.remaining<=1)s+=15;if(pr.total>periods.length*2.5&&days.indexOf(day)<Math.floor(days.length/3))s-=8;s+=pr.today*2;return{...t,score:Math.round(s)};}).sort((a,b)=>b.score-a.score);if(c.length>0){const ch=c[0];const isM=rules.subject_match?.enabled&&ch.subject===lesson.subject;const reasons=[];if(isM)reasons.push("📚");if(profiles[ch.id].concentration>0.5)reasons.push("📌");if(profiles[ch.id].remaining<=1)reasons.push("🔄");asgn.push({...lesson,coverTeacherId:ch.id,coverTeacherName:ch.name,coverTeacherSubject:ch.subject,score:ch.score,isSubjectMatch:isM,reasons});if(!tA[lesson.period])tA[lesson.period]=new Set();tA[lesson.period].add(ch.id);tW[ch.id]=(tW[ch.id]||0)+1;log.push({t:"s",m:`✅ ${lesson.period} ${lesson.class} → ${ch.name} [${ch.score}] ${reasons.join(" ")}`});}else{unr.push(lesson);log.push({t:"f",m:`❌ ${lesson.period} ${lesson.class} [${fl.join(",")}]`});}});
    log.push({t:"h",m:`\n📊 ${asgn.length} assigned, ${unr.length} unresolved`});
    if(unr.length>0&&analysis.status==="impossible")log.push({t:"w",m:`ℹ Pre-analysis predicted ${analysis.bestCaseUnresolved} minimum unresolved`});
    setIntelSolution({day,assignments:asgn,unresolved:unr,reserved:[...reserved].map(id=>({id,name:gt(id)?.name,periods:rMap[id]||[]})),scarcePeriods:scarce,forecast:fc,analysis});setIntelLog(log);},[selectedSolverDay,getLessonsForDay,getCandidates,premiumRules,gwc,gmc,currentWeek,teachers,getFreePeriods,didCoverOnDay,getWeeklyFreeProfile,getRawFreeIds,gt,forecast,absences,days,periods,classes,timetable,reserveThreshold,sixthFormClasses,analyseDay]);

  const applySolution=(sol)=>{if(!sol)return;sol.assignments.forEach(a=>assignCover(a.day,a.period,a.class,a.coverTeacherId));setImportSuccess(`Applied ${sol.assignments.length} assignments.`);setTimeout(()=>setImportSuccess(null),3000);};

  // ═══ OPTIMIZER ═══
  const optimizerData=useMemo(()=>{if(!teachers.length||!days.length||!periods.length)return[];const ts=days.length*periods.length;return teachers.map(t=>{const pr={};let tf=0;days.forEach(d=>{let free=0;periods.forEach(p=>{let busy=false;classes.forEach(c=>{const l=timetable[c]?.[d]?.[p];if(l&&l.teacher===t.id)busy=true;});if(!busy)free++;});pr[d]=free;tf+=free;});const dwf=days.filter(d=>pr[d]>0).length;const sr=days.length>0?dwf/days.length:1;const mp=tf/Math.max(days.length,1);const v=days.reduce((a,d)=>a+(pr[d]-mp)**2,0)/Math.max(days.length,1);const cv=mp>0?Math.sqrt(v)/mp:0;const sf=Math.max(0.4,1-cv*0.5)*(0.5+0.5*sr);const raw=optBase*Math.log(1+tf)*sf*optTermWeeks;return{...t,totalFrees:tf,profile:pr,spreadFactor:+sf.toFixed(2),daysWithFrees:dwf,freePercent:+(tf/ts*100).toFixed(1),optimalTermly:Math.max(1,Math.round(raw)),optimalWeekly:Math.max(1,Math.round(raw/optTermWeeks)),rawTermly:+raw.toFixed(1)};}).sort((a,b)=>b.totalFrees-a.totalFrees);},[teachers,days,periods,classes,timetable,optBase,optTermWeeks]);

  const applyOptimizedLimits=()=>{const nc={};optimizerData.forEach(t=>{nc[t.id]=t.optimalWeekly;});setCoverConstraints(nc);setOptApplied(true);setImportSuccess(`Applied optimized limits for ${optimizerData.length} teachers.`);setTimeout(()=>{setImportSuccess(null);setOptApplied(false);},3000);};

  // ── Styles ──
  const tbs=(tab)=>({padding:"10px 14px",border:"none",borderBottom:activeTab===tab?"3px solid #1a3a5c":"3px solid transparent",background:"none",color:activeTab===tab?"#1a3a5c":"#7a8a9a",fontWeight:activeTab===tab?700:500,cursor:"pointer",fontSize:"12px",fontFamily:"'DM Sans',sans-serif",whiteSpace:"nowrap"});
  const cd={background:"#fff",borderRadius:"12px",padding:"24px",boxShadow:"0 1px 4px rgba(0,0,0,0.06)",border:"1px solid #e8ecf0"};
  const bP={background:"#1a3a5c",color:"#fff",border:"none",borderRadius:"8px",padding:"10px 20px",cursor:"pointer",fontWeight:600,fontSize:"13px",fontFamily:"'DM Sans',sans-serif"};
  const bS={background:"#f0f4f8",color:"#1a3a5c",border:"1px solid #d0d8e0",borderRadius:"8px",padding:"8px 16px",cursor:"pointer",fontWeight:500,fontSize:"13px",fontFamily:"'DM Sans',sans-serif"};
  const bD={background:"#fff",color:"#c0392b",border:"1px solid #e8c5c5",borderRadius:"6px",padding:"5px 12px",cursor:"pointer",fontSize:"12px",fontFamily:"'DM Sans',sans-serif"};
  const bG={background:"#27ae60",color:"#fff",border:"none",borderRadius:"8px",padding:"10px 20px",cursor:"pointer",fontWeight:600,fontSize:"13px",fontFamily:"'DM Sans',sans-serif"};
  const sl={padding:"8px 12px",borderRadius:"8px",border:"1px solid #d0d8e0",fontSize:"13px",fontFamily:"'DM Sans',sans-serif",background:"#fff",color:"#1a3a5c"};
  const bdg=(b,c)=>({display:"inline-block",padding:"2px 9px",borderRadius:"10px",fontSize:"11px",fontWeight:700,background:b,color:c});
  const pl=(a)=>({padding:"6px 14px",border:"none",cursor:"pointer",borderRadius:"6px",background:a?"#1a3a5c":"transparent",color:a?"#fff":"#1a3a5c",fontWeight:600,fontSize:"12px",fontFamily:"'DM Sans',sans-serif"});

  // ── Reusable Solver UI ──
  const SolverResult=({solution,log,onApply})=>{if(!solution)return null;const an=solution.analysis;return(<div>
    {/* ── Analysis Panel ── */}
    {an&&an.totalNeeded>0&&<div style={{borderRadius:"10px",padding:"14px 18px",marginBottom:"14px",border:an.status==="impossible"?"2px solid #c0392b":an.status==="constrained"?"2px solid #e67e22":"2px solid #27ae60",background:an.status==="impossible"?"#fef5f5":an.status==="constrained"?"#fef9f5":"#f5fef9"}}>
      <div style={{display:"flex",justifyContent:"space-between",alignItems:"center",marginBottom:"8px"}}>
        <div style={{fontWeight:800,fontSize:"14px",color:an.status==="impossible"?"#c0392b":an.status==="constrained"?"#e67e22":"#27ae60"}}>{an.status==="impossible"?"🚫 IMPOSSIBLE — Not enough staff":an.status==="constrained"?"⚠️ CONSTRAINED — Very tight":"✅ SOLVABLE"}</div>
        <div style={{fontSize:"11px",color:"#7a8a9a"}}>{an.totalNeeded} lessons · best case: {an.totalNeeded-an.bestCaseUnresolved}/{an.totalNeeded}</div>
      </div>
      {an.status==="impossible"&&<div style={{fontSize:"12px",color:"#c0392b",marginBottom:"8px",fontWeight:600}}>At least {an.bestCaseUnresolved} lesson{an.bestCaseUnresolved>1?"s":""} cannot be covered regardless of assignment order. {an.guaranteedShortfall} due to periods with more lessons than available teachers.</div>}
      {an.status==="constrained"&&<div style={{fontSize:"12px",color:"#e67e22",marginBottom:"8px"}}>All periods individually have enough teachers, but shared availability across periods means {an.bestCaseUnresolved} will likely be unresolved.</div>}
      {/* Per-period breakdown */}
      <div style={{display:"flex",gap:"6px",flexWrap:"wrap"}}>
        {Object.entries(an.impossiblePeriods||{}).map(([p,v])=><div key={p} style={{padding:"6px 10px",borderRadius:"6px",background:"#fff",border:"2px solid #c0392b",fontSize:"11px",textAlign:"center"}}><div style={{fontWeight:800,color:"#c0392b"}}>{p}</div><div style={{color:"#c0392b"}}>{v.available} free / {v.needed} need</div><div style={{fontWeight:700,color:"#c0392b",fontSize:"10px"}}>{v.shortfall} unfillable</div></div>)}
        {Object.entries(an.tightPeriods||{}).map(([p,v])=><div key={p} style={{padding:"6px 10px",borderRadius:"6px",background:"#fff",border:"2px solid #e67e22",fontSize:"11px",textAlign:"center"}}><div style={{fontWeight:800,color:"#e67e22"}}>{p}</div><div style={{color:"#e67e22"}}>{v.available} free / {v.needed} need</div><div style={{fontWeight:600,color:"#e67e22",fontSize:"10px"}}>+{v.surplus} surplus</div></div>)}
        {Object.entries(an.okPeriods||{}).map(([p,v])=><div key={p} style={{padding:"6px 10px",borderRadius:"6px",background:"#fff",border:"1px solid #d0f0dd",fontSize:"11px",textAlign:"center"}}><div style={{fontWeight:700,color:"#27ae60"}}>{p}</div><div style={{color:"#27ae60"}}>{v.available} / {v.needed}</div></div>)}
      </div>
      {an.status==="impossible"&&<div style={{marginTop:"10px",padding:"8px 12px",background:"rgba(192,57,43,0.08)",borderRadius:"6px",fontSize:"11px",color:"#1a3a5c"}}><span style={{fontWeight:700}}>💡 Options:</span> Merge classes for unsupervised study, use TAs/support staff, set work for self-study, or split classes between adjacent rooms where a nearby teacher can monitor</div>}
    </div>}
    {solution.reserved?.length>0&&<div style={{background:"#f8f5ff",borderRadius:"10px",padding:"12px 16px",marginBottom:"12px",border:"1px solid #e0d0f0"}}><div style={{fontWeight:700,fontSize:"12px",color:"#8e44ad",marginBottom:"4px"}}>🔒 Reserved</div><div style={{display:"flex",gap:"6px",flexWrap:"wrap"}}>{solution.reserved.map(r=><span key={r.id} style={{padding:"4px 10px",background:"#fff",borderRadius:"6px",border:"1px solid #d0c0e8",fontSize:"11px"}}><b style={{color:"#8e44ad"}}>{r.name}</b> → {r.periods.join(", ")}</span>)}</div></div>}{solution.scarcePeriods&&Object.keys(solution.scarcePeriods).length>0&&<div style={{background:"#fef9f5",borderRadius:"10px",padding:"12px 16px",marginBottom:"12px",border:"1px solid #f0ddd0"}}><div style={{fontWeight:700,fontSize:"12px",color:"#e67e22",marginBottom:"4px"}}>⚠ Scarce</div><div style={{display:"flex",gap:"6px",flexWrap:"wrap"}}>{Object.entries(solution.scarcePeriods).map(([p,s])=><span key={p} style={{padding:"4px 10px",background:"#fff",borderRadius:"6px",border:"1px solid #f0ddd0",fontSize:"11px"}}><b style={{color:"#e67e22"}}>{p}</b>: {s.available}/{s.needed}</span>)}</div></div>}{solution.assignments?.length>0&&<div style={{marginBottom:"16px"}}><h5 style={{margin:"0 0 10px",fontSize:"13px",fontWeight:700,color:"#27ae60"}}>✅ Assignments ({solution.assignments.length})</h5>{solution.assignments.map((a,i)=><div key={i} style={{padding:"10px 14px",borderRadius:"8px",background:"#f5fef9",border:"1px solid #d0f0dd",marginBottom:"6px",display:"flex",justifyContent:"space-between",alignItems:"center",flexWrap:"wrap",gap:"6px"}}><div style={{display:"flex",gap:"8px",alignItems:"center",flexWrap:"wrap"}}><span style={bdg("#27ae60","#fff")}>{a.period}</span><span style={{fontWeight:600,color:"#1a3a5c",fontSize:"13px"}}>{a.class}</span><span style={{color:"#5a6a7a",fontSize:"12px"}}>{a.subject}</span><span>→</span><span style={{fontWeight:700,color:"#27ae60"}}>{a.coverTeacherName}</span>{a.isSubjectMatch&&<span style={bdg("#f0e8f8","#8e44ad")}>📚</span>}</div><div style={{display:"flex",gap:"3px",flexWrap:"wrap"}}>{(a.reasons||[]).map((r,j)=><span key={j} style={{fontSize:"10px",padding:"2px 5px",borderRadius:"4px",background:"#f0f4f8",color:"#5a6a7a"}}>{r}</span>)}<span style={{fontSize:"10px",color:"#999"}}>[{a.score}]</span></div></div>)}</div>}{solution.unresolved?.length>0&&<div style={{marginBottom:"16px"}}><h5 style={{margin:"0 0 10px",fontSize:"13px",fontWeight:700,color:"#c0392b"}}>❌ Unresolved ({solution.unresolved.length}){an&&an.status==="impossible"&&<span style={{fontWeight:400,fontSize:"11px",color:"#999"}}> — minimum {an.bestCaseUnresolved} unavoidable</span>}</h5>{solution.unresolved.map((u,i)=><div key={i} style={{padding:"8px 14px",borderRadius:"8px",background:"#fef5f5",border:"1px solid #f0c5c5",marginBottom:"4px",fontSize:"13px"}}><span style={bdg("#c0392b","#fff")}>{u.period}</span> {u.class} — {u.subject}</div>)}</div>}{solution.assignments?.length>0&&<button style={bG} onClick={()=>onApply(solution)}>✓ Apply ({solution.assignments.length})</button>}<details style={{marginTop:"12px"}}><summary style={{cursor:"pointer",fontWeight:600,fontSize:"13px",color:"#1a3a5c"}}>📋 Log</summary><div style={{background:"#1a1a2e",borderRadius:"10px",padding:"14px",maxHeight:"220px",overflowY:"auto",marginTop:"8px"}}><div style={{fontFamily:"monospace",fontSize:"11px",lineHeight:1.8}}>{log.map((e,i)=><div key={i} style={{color:e.t==="s"?"#6fdb8f":e.t==="f"?"#ff7b7b":e.t==="w"?"#ffcf6f":e.t==="r"?"#c4a0ff":e.t==="h"?"#fff":e.t==="d"?"#666":"#aaa",...(e.t==="h"?{fontWeight:700}:{})}}>{e.m}</div>)}</div></div></details></div>);};
  const SolverControls=({btnStyle,icon,label,onRun,extra})=>(<div style={{display:"flex",alignItems:"center",gap:"12px",marginBottom:"20px",flexWrap:"wrap"}}><div><label style={{fontSize:"12px",fontWeight:600,color:"#7a8a9a",display:"block",marginBottom:"4px"}}>Day</label><select style={sl} value={selectedSolverDay} onChange={e=>setSelectedSolverDay(e.target.value)}>{days.map(d=><option key={d}>{d}</option>)}</select></div>{extra}<button style={{...btnStyle,marginTop:"18px"}} onClick={onRun}>{icon} {label}</button><div style={{marginTop:"18px",fontSize:"12px",color:"#999"}}>{absences.filter(a=>a.day===selectedSolverDay).length} abs</div></div>);

  // ═══ SETUP SCREEN ═══
  if(!setupComplete){
    const mp=mainParsed;
    const canFinish=mp?.teachers?.length>0&&mp?.timetable;
    const errBox={background:"#fef5f5",border:"1px solid #f0c5c5",borderRadius:"10px",padding:"12px",marginTop:"10px"};
    const okBox={background:"#f0faf5",border:"1px solid #c0e8d0",borderRadius:"10px",padding:"12px",marginTop:"10px"};
    return(<div style={{fontFamily:"'DM Sans',sans-serif",background:"linear-gradient(135deg,#1a3a5c 0%,#2c5f8a 100%)",minHeight:"100vh",display:"flex",alignItems:"center",justifyContent:"center",padding:"24px"}}>
      <link href="https://fonts.googleapis.com/css2?family=DM+Sans:wght@400;500;600;700;800&display=swap" rel="stylesheet"/>
      <div style={{background:"#fff",borderRadius:"20px",padding:"36px",maxWidth:"780px",width:"100%",maxHeight:"90vh",overflowY:"auto",boxShadow:"0 20px 60px rgba(0,0,0,0.3)"}}>
        <div style={{textAlign:"center",marginBottom:"28px"}}><div style={{fontSize:"48px",marginBottom:"8px"}}>📋</div><h1 style={{margin:0,fontSize:"26px",fontWeight:800,color:"#1a3a5c"}}>CoverBoard Setup</h1><p style={{margin:"8px 0 0",color:"#7a8a9a",fontSize:"14px"}}>Upload your timetable — flat CSV or per-class grid files. Format is auto-detected.</p></div>

        {/* ── Format guide ── */}
        {!mp&&<div style={{...cd,marginBottom:"16px",borderLeft:"4px solid #e8ecf0",background:"#fafcff"}}>
          <h3 style={{margin:"0 0 12px",fontSize:"15px",color:"#1a3a5c"}}>Accepted Formats</h3>
          <p style={{margin:"0 0 14px",fontSize:"12px",color:"#7a8a9a"}}>CoverBoard auto-detects which format you're using. Both work equally well.</p>

          <div style={{display:"grid",gridTemplateColumns:"1fr 1fr",gap:"14px"}}>
            {/* Grid format */}
            <div style={{background:"#fff",borderRadius:"10px",border:"1px solid #d8e4f0",padding:"14px",position:"relative"}}>
              <div style={{display:"flex",alignItems:"center",gap:"6px",marginBottom:"10px"}}>
                <span style={{fontSize:"18px"}}>📊</span>
                <div><div style={{fontWeight:700,fontSize:"13px",color:"#1a3a5c"}}>Grid — Per-Class Files</div>
                <div style={{fontSize:"10px",color:"#7a8a9a"}}>One file per class (7A.csv, 7B.csv…)</div></div>
              </div>
              <div style={{background:"#f6f8fb",borderRadius:"6px",padding:"10px",fontFamily:"monospace",fontSize:"9px",lineHeight:"1.5",color:"#4a5568",overflowX:"auto",whiteSpace:"pre"}}>
{`2025-26 Timetable for 7I
    ,Period 1  ,Period 2  ,Period 3
    ,08:00-08:50,08:50-09:40,10:00-10:50
Monday A ,"Ms Smith  ,"Mr Jones  ,"Dr Patel
          English    Maths      Science
          Room 101"  Room 102"  Room 201"`}
              </div>
              <div style={{marginTop:"8px",fontSize:"10px",color:"#7a8a9a"}}>
                <div>✓ Days down the left, periods across the top</div>
                <div>✓ Each cell: Teacher, Subject, Room (on separate lines)</div>
                <div>✓ Split classes supported (multiple teachers per cell)</div>
                <div>✓ Select multiple files at once</div>
                <div>✓ Period times extracted automatically</div>
                <div style={{marginTop:"4px",color:"#2980b9",fontWeight:600}}>Works with: SIMS grid exports, Excel timetable sheets</div>
              </div>
            </div>

            {/* Flat format */}
            <div style={{background:"#fff",borderRadius:"10px",border:"1px solid #d8e4f0",padding:"14px"}}>
              <div style={{display:"flex",alignItems:"center",gap:"6px",marginBottom:"10px"}}>
                <span style={{fontSize:"18px"}}>📋</span>
                <div><div style={{fontWeight:700,fontSize:"13px",color:"#1a3a5c"}}>Flat — Single File</div>
                <div style={{fontSize:"10px",color:"#7a8a9a"}}>One row per lesson, all classes in one file</div></div>
              </div>
              <div style={{background:"#f6f8fb",borderRadius:"6px",padding:"10px",fontFamily:"monospace",fontSize:"9px",lineHeight:"1.5",color:"#4a5568",overflowX:"auto",whiteSpace:"pre"}}>
{`Class,Day,Period,Subject,Teacher,Room
7A   ,Monday ,P1 ,English,Ms Smith ,R101
7A   ,Monday ,P2 ,Maths  ,Mr Jones ,R102
7B   ,Monday ,P1 ,Science,Dr Patel ,S201`}
              </div>
              <div style={{marginTop:"8px",fontSize:"10px",color:"#7a8a9a"}}>
                <div>✓ Required: Class, Day, Period, Teacher</div>
                <div>✓ Optional: Subject, Room, Code, Year</div>
                <div>✓ One file for the whole school</div>
                <div>✓ Column names auto-detected</div>
                <div style={{marginTop:"4px",color:"#2980b9",fontWeight:600}}>Works with: TimeTabler, aSc, Untis, Edval, Arbor, Bromcom</div>
              </div>
            </div>
          </div>
        </div>}

        {/* ── Main timetable upload ── */}
        <div style={{...cd,marginBottom:"16px",borderLeft:mp?.teachers?"4px solid #27ae60":"4px solid #2980b9",background:!mp?"#f8fafc":"#fff"}}>
          <div style={{display:"flex",justifyContent:"space-between",alignItems:"center"}}>
            <div>
              <h3 style={{margin:0,fontSize:"16px",color:"#1a3a5c"}}>Timetable {setupFormat==="grid"?"Grid Files":"CSV"} <span style={{color:"#c0392b"}}>*</span></h3>
              <p style={{margin:"4px 0 0",fontSize:"12px",color:"#7a8a9a"}}>{setupFormat==="grid"
                ?<>Grid format detected — upload one CSV per class (e.g. 7A.csv, 7B.csv)</>
                :<>Flat CSV or grid-format class timetables — auto-detected</>
              }</p>
              <p style={{margin:"2px 0 0",fontSize:"11px",color:"#aab"}}>{setupFormat==="grid"
                ?"Select multiple files at once with Ctrl/Cmd+click"
                :"Flat: Class, Day, Period, Teacher • Grid: period columns, day rows, Teacher/Subject/Room cells"
              }</p>
            </div>
            <label style={{...bP,cursor:"pointer",padding:"10px 20px",fontSize:"14px"}}><input type="file" accept=".csv,.txt,.xlsx" multiple style={{display:"none"}} onChange={handleSetupFile("timetable")}/>{mp?"🔄 Replace":"📁 Upload"}</label>
          </div>
          {/* Format badge */}
          {setupFormat&&<div style={{marginTop:"8px",display:"flex",gap:"6px",alignItems:"center"}}>
            <span style={bdg(setupFormat==="grid"?"#e8f0ff":"#f0f8e8",setupFormat==="grid"?"#2980b9":"#27ae60")}>{setupFormat==="grid"?"📊 Grid Format":"📋 Flat Format"}</span>
            {setupFormat==="grid"&&setupGridFiles.length>0&&<span style={bdg("#f0f4f8","#666")}>{setupGridFiles.length} file{setupGridFiles.length!==1?"s":""}: {setupGridFiles.map(f=>f.name.replace(/\.[^.]+$/,"").replace(/_xlsx_.*|_csv.*/i,"")).join(", ")}</span>}
          </div>}
          {mp?.error&&<div style={errBox}><span style={{color:"#c0392b",fontSize:"13px"}}>❌ {mp.error}</span></div>}
          {mp?.warnings?.length>0&&<div style={{background:"#fffbf0",border:"1px solid #f0e0b0",borderRadius:"10px",padding:"12px",marginTop:"10px"}}>{mp.warnings.map((w,i)=><div key={i} style={{color:"#b57d00",fontSize:"12px"}}>⚠️ {w}</div>)}</div>}

          {/* ── Extracted data summary ── */}
          {mp?.teachers&&<div style={okBox}>
            <div style={{fontWeight:700,fontSize:"14px",color:"#27ae60",marginBottom:"10px"}}>{mp.format==="grid"
              ?`✓ Parsed ${mp.fileCount} class timetable${mp.fileCount!==1?"s":""} — ${mp.totalRows} lesson slots`
              :`✓ Extracted from ${mp.totalRows} rows`
            }</div>

            {/* Stats grid */}
            <div style={{display:"grid",gridTemplateColumns:"repeat(4,1fr)",gap:"8px",marginBottom:"14px"}}>
              {[{l:"Teachers",v:mp.teachers.length,c:"#1a3a5c",i:"👩‍🏫"},{l:"Classes",v:mp.classes.length,c:"#2980b9",i:"🏫"},{l:"Days",v:mp.days.length,c:"#8e44ad",i:"📅"},{l:"Periods",v:mp.periods.length,c:"#e67e22",i:"⏰"}].map((s,i)=><div key={i} style={{background:"#fff",borderRadius:"8px",padding:"10px",textAlign:"center",border:"1px solid #e0e8f0"}}>
                <div style={{fontSize:"18px"}}>{s.i}</div>
                <div style={{fontSize:"20px",fontWeight:800,color:s.c}}>{s.v}</div>
                <div style={{fontSize:"9px",color:"#7a8a9a"}}>{s.l}</div>
              </div>)}
            </div>

            {/* Column detection badges */}
            <div style={{display:"flex",gap:"4px",flexWrap:"wrap",marginBottom:"12px"}}>
              {mp.format==="grid"&&<span style={bdg("#e0f0ff","#2980b9")}>📊 Grid format — per-class files</span>}
              {mp.format==="grid"&&mp.periodTimes&&<span style={bdg("#e8f8ee","#27ae60")}>✓ Period Times auto-detected</span>}
              {mp.format!=="grid"&&mp.hasCodeColumn&&<span style={bdg("#e0f0ff","#2980b9")}>✓ Staff Codes</span>}
              {mp.hasSubjectColumn&&<span style={bdg("#e8f8ee","#27ae60")}>✓ Subjects</span>}
              {mp.format!=="grid"&&mp.hasYearColumn&&<span style={bdg("#f0e8f8","#8e44ad")}>✓ Year Groups</span>}
              {mp.format!=="grid"&&<span style={bdg("#f0f4f8","#1a3a5c")}>Columns: {mp.headers?.join(", ")}</span>}
              <span style={bdg(mp.linked===mp.totalRows?"#e8f8ee":"#fff8e8",mp.linked===mp.totalRows?"#27ae60":"#b57d00")}>{mp.linked}/{mp.totalRows} linked</span>
            </div>

            {/* Teachers extracted */}
            <details style={{marginBottom:"10px"}}><summary style={{cursor:"pointer",fontWeight:700,fontSize:"12px",color:"#1a3a5c"}}>👩‍🏫 Teachers ({mp.teachers.length}) — auto-extracted with primary subjects</summary>
              <div style={{display:"grid",gridTemplateColumns:"repeat(auto-fill,minmax(200px,1fr))",gap:"4px",marginTop:"8px",maxHeight:"180px",overflowY:"auto"}}>
                {mp.teachers.map(t=><div key={t.id} style={{padding:"6px 10px",borderRadius:"6px",background:"#fafbfc",border:"1px solid #eee",display:"flex",justifyContent:"space-between",alignItems:"center"}}>
                  <div><span style={{fontWeight:700,fontSize:"11px",color:"#1a3a5c"}}>{t.name}</span>{t.code&&<span style={{fontSize:"9px",color:"#2980b9",marginLeft:"4px"}}>({t.code})</span>}</div>
                  <span style={bdg(subjectColors[t.subject]||"#f0f4f8","#333")}>{t.subject}</span>
                </div>)}
              </div>
            </details>

            {/* Days & Periods */}
            <div style={{display:"grid",gridTemplateColumns:"1fr 1fr",gap:"10px",marginBottom:"10px"}}>
              <div><div style={{fontSize:"10px",color:"#7a8a9a",fontWeight:600,marginBottom:"3px"}}>Days ({mp.days.length})</div><div style={{display:"flex",gap:"3px",flexWrap:"wrap"}}>{mp.days.map(d=><span key={d} style={bdg("#e8f0f8","#1a3a5c")}>{d}</span>)}</div></div>
              <div><div style={{fontSize:"10px",color:"#7a8a9a",fontWeight:600,marginBottom:"3px"}}>Periods ({mp.periods.length})</div><div style={{display:"flex",gap:"3px",flexWrap:"wrap"}}>{mp.periods.map(p=><span key={p} style={bdg("#e8f0f8","#1a3a5c")}>{p}</span>)}</div></div>
            </div>

            {/* Subjects & Classes */}
            <details><summary style={{cursor:"pointer",fontWeight:700,fontSize:"12px",color:"#1a3a5c"}}>📚 Subjects ({mp.subjects.length}) & Classes ({mp.classes.length})</summary>
              <div style={{marginTop:"6px"}}>
                <div style={{display:"flex",gap:"3px",flexWrap:"wrap",marginBottom:"6px"}}>{mp.subjects.map(s=><span key={s} style={bdg(subjectColors[s]||"#f0f4f8","#333")}>{s}</span>)}</div>
                <div style={{display:"flex",gap:"3px",flexWrap:"wrap"}}>{mp.classes.map(c=><span key={c} style={bdg("#f0f4f8","#333")}>{c}</span>)}</div>
              </div>
            </details>
          </div>}
        </div>

        {/* ── Optional extras ── */}
        <div style={{...cd,marginBottom:"16px",borderLeft:"4px solid #e8ecf0"}}><h3 style={{margin:"0 0 12px",fontSize:"15px",color:"#1a3a5c"}}>Optional</h3><div style={{display:"grid",gridTemplateColumns:"1fr 1fr",gap:"10px"}}><div style={{padding:"12px",background:"#fafbfc",borderRadius:"8px",border:"1px solid #eee"}}><div style={{fontWeight:600,fontSize:"12px",color:"#1a3a5c"}}>Period Times</div><div style={{fontSize:"10px",color:"#7a8a9a",marginBottom:"6px"}}>Period, Start, End</div><label style={{...bS,cursor:"pointer",display:"inline-block",fontSize:"11px"}}><input type="file" accept=".csv" style={{display:"none"}} onChange={handleSetupFile("periodTimes")}/>📁</label>{periodTimesParsed?.periodTimes&&<span style={{marginLeft:"6px",fontSize:"11px",color:"#27ae60",fontWeight:600}}>✓</span>}</div><div style={{padding:"12px",background:"#fafbfc",borderRadius:"8px",border:"1px solid #eee"}}><div style={{fontWeight:600,fontSize:"12px",color:"#1a3a5c"}}>Terms</div><div style={{fontSize:"10px",color:"#7a8a9a",marginBottom:"6px"}}>Name, Start Week, End Week</div><label style={{...bS,cursor:"pointer",display:"inline-block",fontSize:"11px"}}><input type="file" accept=".csv" style={{display:"none"}} onChange={handleSetupFile("terms")}/>📁</label>{termsParsed?.terms&&<span style={{marginLeft:"6px",fontSize:"11px",color:"#27ae60",fontWeight:600}}>✓ {termsParsed.terms.length}</span>}</div></div>
          {/* Sixth form selector */}
          {canFinish&&mp.classes.length>0&&<div style={{marginTop:"14px"}}><div style={{fontWeight:600,fontSize:"12px",color:"#1a3a5c",marginBottom:"4px"}}>Sixth Form classes (no cover needed)</div><div style={{display:"flex",gap:"4px",flexWrap:"wrap"}}>{mp.classes.map(c=><button key={c} onClick={()=>setSixthFormClasses(p=>p.includes(c)?p.filter(x=>x!==c):[...p,c])} style={{padding:"4px 10px",borderRadius:"6px",cursor:"pointer",fontSize:"11px",fontFamily:"'DM Sans',sans-serif",border:sixthFormClasses.includes(c)?"2px solid #8e44ad":"2px solid #e0e0e0",background:sixthFormClasses.includes(c)?"#f8f5ff":"#fff",color:sixthFormClasses.includes(c)?"#8e44ad":"#666",fontWeight:sixthFormClasses.includes(c)?700:400}}>{c}</button>)}</div></div>}
        </div>

        {/* ── Launch ── */}
        <div style={{display:"flex",gap:"12px",alignItems:"center",marginTop:"18px"}}><input style={{...sl,flex:1}} placeholder="School name (optional)" value={schoolName} onChange={e=>setSchoolName(e.target.value)}/><button style={{...bG,padding:"12px 28px",fontSize:"15px",opacity:canFinish?1:0.4,pointerEvents:canFinish?"auto":"none"}} onClick={finaliseSetup}>🚀 Launch</button></div>

        {/* ── Template download ── */}
        <div style={{marginTop:"20px",paddingTop:"16px",borderTop:"1px solid #eee"}}><div style={{fontSize:"12px",fontWeight:600,color:"#7a8a9a",marginBottom:"6px"}}>📥 Templates & Format Guide</div>
          <div style={{fontSize:"11px",color:"#999",marginBottom:"8px"}}>CoverBoard auto-detects your format. Upload a single flat CSV or multiple class grid files (7A.csv, 7B.csv, etc.)</div>
          <div style={{display:"flex",gap:"6px",flexWrap:"wrap"}}><button style={{...bS,fontSize:"11px"}} onClick={()=>dlCSV("timetable_template.csv",mkCSV(["Class","Day","Period","Subject","Teacher","Code","Room"],[["7A","Monday","P1","English","Ms Johnson","JOH","R101"],["7A","Monday","P2","Maths","Mr Smith","SMI","R102"],["7B","Monday","P1","Science","Dr Patel","PAT","L201"]]))}>Flat Template</button><button style={{...bS,fontSize:"11px"}} onClick={()=>dlCSV("period_times.csv",mkCSV(["Period","Start","End"],[["P1","08:45","09:35"]]))}>Times Template</button><button style={{...bS,fontSize:"11px"}} onClick={()=>dlCSV("terms.csv",mkCSV(["Term Name","Start Week","End Week"],[["Autumn 1","1","7"]]))}>Terms Template</button></div></div>
      </div></div>);
  }

  // ═══ MAIN APP TABS ═══
  const MONTHS=["September","October","November","December","January","February","March","April","May","June","July","August"];
  const renderDashboard=()=>(<div>
    <div style={{...cd,marginBottom:"20px",padding:"14px 20px",display:"flex",alignItems:"center",gap:"12px",flexWrap:"wrap"}}>
      <span style={{fontSize:"13px",fontWeight:700,color:"#1a3a5c"}}>Week:</span><select style={sl} value={currentWeek} onChange={e=>setCurrentWeek(parseInt(e.target.value))}>{Array.from({length:52},(_,i)=><option key={i+1} value={i+1}>Week {i+1}</option>)}</select>
      <span style={{fontSize:"13px",fontWeight:700,color:"#1a3a5c"}}>Month:</span><select style={sl} value={currentMonth} onChange={e=>setCurrentMonth(e.target.value)}>{MONTHS.map(m=><option key={m}>{m}</option>)}</select>
      <span style={bdg("#e8f0f8","#1a3a5c")}>{curTerm()}</span>
      <div style={{marginLeft:"auto",display:"flex",alignItems:"center",gap:"8px"}}>
        {storageOk&&lastSaved&&<span style={{fontSize:"10px",color:"#27ae60"}}>💾 Saved {lastSaved.toLocaleTimeString()}</span>}
        {!storageOk&&<span style={{fontSize:"10px",color:"#e67e22"}}>⚠ Storage unavailable</span>}
        <span style={{fontSize:"10px",color:"#999"}}>{getStorageSize()}KB</span>
      </div>
    </div>
    <div style={{display:"grid",gridTemplateColumns:"repeat(4,1fr)",gap:"14px",marginBottom:"24px"}}>{[{l:"Teachers",v:teachers.length,c:"#1a3a5c",i:"👩‍🏫"},{l:"Absences",v:absences.length,c:"#e67e22",i:"🔴"},{l:"Uncovered",v:uncoveredLessons.length,c:"#c0392b",i:"⚠️"},{l:"Covered",v:coveredLessons.length,c:"#27ae60",i:"✅"}].map((s,idx)=><div key={idx} style={{...cd,display:"flex",alignItems:"center",gap:"14px",borderLeft:`4px solid ${s.c}`}}><span style={{fontSize:"24px"}}>{s.i}</span><div><div style={{fontSize:"24px",fontWeight:800,color:s.c,lineHeight:1}}>{s.v}</div><div style={{fontSize:"11px",color:"#7a8a9a"}}>{s.l}</div></div></div>)}</div>
    {uncoveredLessons.length>0&&<div style={{...cd,marginBottom:"20px",borderLeft:"4px solid #c0392b"}}><h3 style={{margin:"0 0 12px",fontSize:"14px",color:"#c0392b",fontWeight:700}}>⚠️ Uncovered</h3>{uncoveredLessons.map((l,i)=>{const ft=getFreeTeachers(l.day,l.period).filter(t=>!t.atLimit);return(<div key={i} style={{padding:"8px 12px",background:"#fef9f5",borderRadius:"8px",border:"1px solid #f0ddd0",marginBottom:"4px",display:"flex",justifyContent:"space-between",alignItems:"center",flexWrap:"wrap",gap:"6px"}}><div style={{display:"flex",gap:"8px",alignItems:"center",flexWrap:"wrap"}}><span style={bdg("#c0392b","#fff")}>{l.day} {l.period}</span><span style={{fontWeight:600,color:"#1a3a5c"}}>{l.class}</span><span style={{color:"#7a8a9a",fontSize:"12px"}}>{l.lesson.subject}</span></div><select style={sl} defaultValue="" onChange={e=>{if(e.target.value)assignCover(l.day,l.period,l.class,parseInt(e.target.value));}}><option value="" disabled>Assign...</option>{ft.map(t=><option key={t.id} value={t.id}>{t.name} ({t.weeklyCount}/{t.maxCovers})</option>)}</select></div>);})}</div>}
    {coveredLessons.length>0&&<div style={{...cd,borderLeft:"4px solid #27ae60"}}><h3 style={{margin:"0 0 10px",fontSize:"14px",color:"#27ae60",fontWeight:700}}>✅ Covered</h3>{coveredLessons.map(c=><div key={c.key} style={{display:"flex",justifyContent:"space-between",alignItems:"center",padding:"6px 12px",background:"#f5fef9",borderRadius:"6px",border:"1px solid #d0f0dd",marginBottom:"3px"}}><div style={{display:"flex",gap:"6px",alignItems:"center"}}><span style={bdg("#27ae60","#fff")}>{c.day} {c.period}</span><span style={{fontWeight:600}}>{c.class}</span><span style={{color:"#27ae60",fontSize:"12px"}}>→ {gt(c.coverTeacherId)?.name}</span></div><button style={bD} onClick={()=>removeCover(c.key)}>×</button></div>)}</div>}
    {!uncoveredLessons.length&&!coveredLessons.length&&<div style={{...cd,textAlign:"center",padding:"36px"}}><div style={{fontSize:"44px"}}>📅</div><div style={{fontWeight:600,color:"#1a3a5c",marginTop:"6px"}}>All Clear</div></div>}
  </div>);

  const renderFree=()=>(<div><div style={{marginBottom:"16px"}}><h3 style={{margin:0,fontSize:"18px",fontWeight:800}}><span style={bdg("#e8f8ee","#27ae60")}>FREE</span> <span style={{color:"#27ae60"}}>Solver</span></h3></div><div style={{...cd,marginBottom:"16px"}}><div style={{display:"flex",alignItems:"center",gap:"10px",marginBottom:"12px"}}><span style={{fontWeight:700,color:"#1a3a5c",fontSize:"13px"}}>Limit:</span><button style={{...bS,fontWeight:700}} onClick={()=>setDefaultMaxCovers(Math.max(1,defaultMaxCovers-1))}>−</button><span style={{fontWeight:800,fontSize:"18px",color:"#1a3a5c"}}>{defaultMaxCovers}</span><button style={{...bS,fontWeight:700}} onClick={()=>setDefaultMaxCovers(defaultMaxCovers+1)}>+</button><span style={{fontSize:"12px",color:"#999"}}>/week</span></div><div style={{display:"grid",gridTemplateColumns:"repeat(auto-fill,minmax(200px,1fr))",gap:"4px"}}>{teachers.map(t=>{const cur=gmc(t.id),used=gwc(t.id,currentWeek),has=coverConstraints[t.id]!==undefined;return(<div key={t.id} style={{padding:"5px 8px",borderRadius:"6px",background:has?"#f0f7ff":"#fafbfc",border:"1px solid #eee",display:"flex",justifyContent:"space-between",alignItems:"center"}}><span style={{fontWeight:600,fontSize:"11px"}}>{t.name}</span><div style={{display:"flex",alignItems:"center",gap:"2px"}}><button style={{...bS,padding:"1px 5px",fontSize:"10px"}} onClick={()=>setCoverConstraints(p=>({...p,[t.id]:Math.max(0,(p[t.id]??defaultMaxCovers)-1)}))}>−</button><span style={{fontWeight:700,fontSize:"11px",minWidth:"12px",textAlign:"center"}}>{cur}</span><button style={{...bS,padding:"1px 5px",fontSize:"10px"}} onClick={()=>setCoverConstraints(p=>({...p,[t.id]:(p[t.id]??defaultMaxCovers)+1}))}>+</button><span style={{fontSize:"9px",color:used>=cur?"#c0392b":"#999",marginLeft:"2px"}}>{used}/{cur}</span></div></div>);})}</div></div><div style={{...cd,borderTop:"4px solid #27ae60"}}><SolverControls btnStyle={bG} icon="📋" label="Run Free" onRun={runFreeSolver}/>{freeSolution?<SolverResult solution={freeSolution} log={freeLog} onApply={applySolution}/>:<div style={{textAlign:"center",padding:"20px",color:"#999"}}>📋 Ready</div>}</div></div>);

  const renderPremium=()=>(<div><div style={{display:"flex",justifyContent:"space-between",marginBottom:"16px",flexWrap:"wrap",gap:"8px"}}><h3 style={{margin:0,fontSize:"18px",fontWeight:800}}><span style={bdg("#f0e8f8","#8e44ad")}>PREMIUM</span> <span style={{color:"#8e44ad"}}>Solver</span></h3><button style={bS} onClick={()=>dlCSV("rules.csv",mkCSV(["Rule","Enabled","Value"],Object.entries(premiumRules).map(([k,r])=>[k,r.enabled?"yes":"no",r.value??""])))}>📤 Rules</button></div><div style={{...cd,marginBottom:"16px",borderTop:"4px solid #8e44ad"}}><h4 style={{margin:"0 0 10px",fontSize:"13px",fontWeight:700}}>⚙️ Rules</h4>{Object.entries(premiumRules).map(([key,rule])=><div key={key} style={{padding:"10px 14px",borderRadius:"8px",background:rule.enabled?"#f8f5ff":"#fafbfc",border:rule.enabled?"1px solid #d0c0e8":"1px solid #eee",marginBottom:"6px",display:"flex",justifyContent:"space-between",alignItems:"center",flexWrap:"wrap",gap:"6px"}}><div style={{flex:1,minWidth:"200px"}}><div style={{display:"flex",alignItems:"center",gap:"4px"}}><span>{rule.icon}</span><span style={{fontWeight:700,fontSize:"12px",color:rule.enabled?"#8e44ad":"#999"}}>{rule.label}</span></div><div style={{fontSize:"10px",color:"#7a8a9a",marginLeft:"22px"}}>{rule.desc}{key==="exclude_sixth_form"&&sixthFormClasses.length>0&&rule.enabled?` (${sixthFormClasses.join(", ")})`:""}</div></div><div style={{display:"flex",alignItems:"center",gap:"6px"}}>{(key==="min_free_periods"||key==="max_capacity")&&rule.enabled&&<div style={{display:"flex",alignItems:"center",gap:"2px"}}><button style={{...bS,padding:"2px 6px",fontWeight:700}} onClick={()=>setPremiumRules(p=>({...p,[key]:{...p[key],value:Math.max(1,(p[key].value||2)-1)}}))}>−</button><span style={{fontWeight:800,fontSize:"13px",color:"#8e44ad",minWidth:"14px",textAlign:"center"}}>{rule.value}</span><button style={{...bS,padding:"2px 6px",fontWeight:700}} onClick={()=>setPremiumRules(p=>({...p,[key]:{...p[key],value:(p[key].value||2)+1}}))}>+</button></div>}<button onClick={()=>setPremiumRules(p=>({...p,[key]:{...p[key],enabled:!p[key].enabled}}))} style={{width:"40px",height:"22px",borderRadius:"11px",border:"none",cursor:"pointer",background:rule.enabled?"#8e44ad":"#d0d8e0",position:"relative"}}><div style={{width:"16px",height:"16px",borderRadius:"8px",background:"#fff",position:"absolute",top:"3px",left:rule.enabled?"21px":"3px",transition:"left 0.2s",boxShadow:"0 1px 3px rgba(0,0,0,0.2)"}}/></button></div></div>)}</div><div style={{...cd,borderTop:"4px solid #8e44ad"}}><SolverControls btnStyle={{background:"#8e44ad",color:"#fff",border:"none",borderRadius:"8px",padding:"12px 20px",cursor:"pointer",fontWeight:700,fontSize:"13px",fontFamily:"'DM Sans',sans-serif",marginTop:"18px"}} icon="⚡" label="Run Premium" onRun={runPremiumSolver}/>{premiumSolution?<SolverResult solution={premiumSolution} log={premiumLog} onApply={applySolution}/>:<div style={{textAlign:"center",padding:"20px",color:"#999"}}>⚡ Ready</div>}</div></div>);

  const renderIntelligence=()=>{const fc=forecast[intelForecastDay]||{probs:[],mean:0,model:"—"};const mx=Math.max(...(fc.probs?.map(p=>p.prob)||[0.1]));return(<div><div style={{marginBottom:"16px"}}><h3 style={{margin:0,fontSize:"18px",fontWeight:800}}><span style={bdg("#fff3e0","#e67e22")}>INTELLIGENT</span> <span style={{color:"#e67e22"}}>Predictive Engine</span></h3></div><div style={{...cd,marginBottom:"16px",borderTop:"4px solid #e67e22"}}><h4 style={{margin:"0 0 10px",fontSize:"13px",fontWeight:700}}>📊 Forecast</h4><div style={{display:"flex",gap:"4px",marginBottom:"12px",flexWrap:"wrap"}}>{days.map(d=>{const f=forecast[d]||{mean:0};return(<button key={d} onClick={()=>setIntelForecastDay(d)} style={{padding:"6px 10px",borderRadius:"8px",cursor:"pointer",border:intelForecastDay===d?"2px solid #e67e22":"2px solid #eee",background:intelForecastDay===d?"#fff8f0":"#fff",fontFamily:"'DM Sans',sans-serif",textAlign:"center",minWidth:"60px"}}><div style={{fontWeight:700,fontSize:"10px",color:intelForecastDay===d?"#e67e22":"#1a3a5c"}}>{d.slice(0,3)}</div><div style={{fontSize:"16px",fontWeight:800,color:intelForecastDay===d?"#e67e22":"#333"}}>{f.mean?.toFixed(1)}</div></button>);})}</div><div style={{background:"#fafbfc",borderRadius:"8px",padding:"12px",border:"1px solid #eee"}}><div style={{display:"flex",alignItems:"flex-end",gap:"2px",height:"70px",marginBottom:"4px"}}>{fc.probs?.slice(0,9).map((p,i)=>{const h=mx>0?(p.prob/mx)*100:0;return(<div key={i} style={{flex:1,display:"flex",flexDirection:"column",alignItems:"center",justifyContent:"flex-end",height:"100%"}}><div style={{fontSize:"8px",fontWeight:600,color:p.prob>0.15?"#e67e22":"#999"}}>{(p.prob*100).toFixed(0)}%</div><div style={{width:"100%",height:`${Math.max(h,2)}%`,minHeight:"2px",background:p.k<=Math.round(fc.mean)?"linear-gradient(#e67e22,#f39c12)":"#ccc",borderRadius:"3px 3px 0 0"}}/></div>);})}</div><div style={{display:"flex",gap:"2px"}}>{fc.probs?.slice(0,9).map((p,i)=><div key={i} style={{flex:1,textAlign:"center",fontSize:"9px",fontWeight:600}}>{p.k}</div>)}</div></div><div style={{display:"grid",gridTemplateColumns:"repeat(4,1fr)",gap:"6px",marginTop:"10px"}}>{[1,2,3,4].map(k=>{const prob=poissonPGTE(k,fc.mean||0);return(<div key={k} style={{background:"#fff",borderRadius:"6px",padding:"6px",textAlign:"center",border:"1px solid #eee"}}><div style={{fontSize:"14px",fontWeight:800,color:prob>0.5?"#c0392b":prob>0.3?"#e67e22":"#27ae60"}}>{(prob*100).toFixed(0)}%</div><div style={{fontSize:"8px",color:"#7a8a9a"}}>P(≥{k})</div></div>);})}</div></div><div style={{...cd,borderTop:"4px solid #e67e22"}}><SolverControls btnStyle={{background:"#e67e22",color:"#fff",border:"none",borderRadius:"8px",padding:"12px 20px",cursor:"pointer",fontWeight:700,fontSize:"13px",fontFamily:"'DM Sans',sans-serif",marginTop:"18px"}} icon="🧠" label="Run Intelligent" onRun={runIntelligentSolver} extra={<div style={{marginTop:"18px",display:"flex",alignItems:"center",gap:"3px"}}><span style={{fontSize:"10px",color:"#7a8a9a"}}>Reserve:</span><button style={{...bS,padding:"2px 5px"}} onClick={()=>setReserveThreshold(Math.max(1,reserveThreshold-1))}>−</button><span style={{fontWeight:800,color:"#e67e22"}}>{reserveThreshold}</span><button style={{...bS,padding:"2px 5px"}} onClick={()=>setReserveThreshold(reserveThreshold+1)}>+</button></div>}/>{intelSolution?<SolverResult solution={intelSolution} log={intelLog} onApply={applySolution}/>:<div style={{textAlign:"center",padding:"20px",color:"#999"}}>🧠 Ready</div>}</div></div>);};

  const renderOptimizer=()=>{const maxT=Math.max(...optimizerData.map(t=>t.optimalTermly),1);const totalCap=optimizerData.reduce((a,t)=>a+t.optimalTermly,0);const avgW=optimizerData.length?(optimizerData.reduce((a,t)=>a+t.optimalWeekly,0)/optimizerData.length).toFixed(1):"0";return(<div><div style={{marginBottom:"16px"}}><h3 style={{margin:0,fontSize:"18px",fontWeight:800}}><span style={bdg("#e0f0ff","#2980b9")}>OPTIMIZER</span> <span style={{color:"#2980b9"}}>Allocation</span></h3><p style={{margin:"4px 0 0",fontSize:"12px",color:"#7a8a9a"}}><code style={{background:"#f0f4f8",padding:"1px 5px",borderRadius:"4px"}}>base × ln(1+frees) × spread × weeks</code></p></div><div style={{...cd,marginBottom:"16px",borderTop:"4px solid #2980b9"}}><div style={{display:"flex",gap:"20px",flexWrap:"wrap",alignItems:"flex-start"}}><div><label style={{fontSize:"11px",fontWeight:600,color:"#7a8a9a"}}>Base</label><div style={{display:"flex",alignItems:"center",gap:"6px"}}><input type="range" min="0.3" max="3.0" step="0.1" value={optBase} onChange={e=>setOptBase(parseFloat(e.target.value))} style={{width:"120px",accentColor:"#2980b9"}}/><span style={{fontWeight:800,fontSize:"16px",color:"#2980b9"}}>{optBase.toFixed(1)}</span></div></div><div><label style={{fontSize:"11px",fontWeight:600,color:"#7a8a9a"}}>Term weeks</label><div style={{display:"flex",alignItems:"center",gap:"4px"}}><button style={{...bS,padding:"3px 8px",fontWeight:700}} onClick={()=>setOptTermWeeks(Math.max(1,optTermWeeks-1))}>−</button><span style={{fontWeight:800,fontSize:"16px",color:"#2980b9"}}>{optTermWeeks}</span><button style={{...bS,padding:"3px 8px",fontWeight:700}} onClick={()=>setOptTermWeeks(optTermWeeks+1)}>+</button></div></div><button style={{background:"#2980b9",color:"#fff",border:"none",borderRadius:"8px",padding:"10px 20px",cursor:"pointer",fontWeight:700,fontSize:"13px",fontFamily:"'DM Sans',sans-serif",marginTop:"14px"}} onClick={applyOptimizedLimits}>✓ Apply Limits</button></div><div style={{display:"grid",gridTemplateColumns:"repeat(3,1fr)",gap:"10px",marginTop:"16px"}}>{[{l:"Term Capacity",v:totalCap,c:"#2980b9"},{l:"Avg Weekly",v:avgW,c:"#27ae60"},{l:"Teachers",v:optimizerData.length,c:"#1a3a5c"}].map((s,i)=><div key={i} style={{background:"#f8fafc",borderRadius:"8px",padding:"10px",textAlign:"center",border:"1px solid #eee"}}><div style={{fontSize:"9px",color:"#7a8a9a"}}>{s.l}</div><div style={{fontSize:"20px",fontWeight:800,color:s.c}}>{s.v}</div></div>)}</div></div><div style={{...cd}}><div style={{display:"flex",flexDirection:"column",gap:"4px"}}><div style={{display:"grid",gridTemplateColumns:"160px 1fr 60px 45px 45px",gap:"6px",padding:"3px 6px",fontSize:"9px",fontWeight:700,color:"#7a8a9a",borderBottom:"1px solid #eee"}}><div>Teacher</div><div>Frees/Day</div><div>Spread</div><div style={{textAlign:"center"}}>/wk</div><div style={{textAlign:"center"}}>/trm</div></div>{optimizerData.map(t=>{const maxF=Math.max(...optimizerData.map(x=>x.totalFrees),1);return(<div key={t.id} style={{display:"grid",gridTemplateColumns:"160px 1fr 60px 45px 45px",gap:"6px",alignItems:"center",padding:"6px",borderRadius:"6px",background:"#fafbfc",border:"1px solid #eee"}}><div><div style={{fontWeight:700,fontSize:"12px",color:"#1a3a5c"}}>{t.name}</div><div style={{fontSize:"9px",color:"#7a8a9a"}}>{t.subject} · {t.totalFrees} free</div></div><div style={{display:"flex",gap:"1px",height:"20px",alignItems:"flex-end"}}>{days.map(d=>{const h=maxF>0?(t.profile[d]/maxF)*100:0;return(<div key={d} style={{flex:1,height:`${Math.max(h,4)}%`,background:t.profile[d]>0?`rgba(41,128,185,${0.3+0.7*(t.profile[d]/maxF)})`:"#eee",borderRadius:"1px 1px 0 0",minHeight:"2px"}}/>);})}</div><div style={{display:"flex",alignItems:"center",gap:"2px"}}><div style={{flex:1,height:"5px",background:"#eee",borderRadius:"3px",overflow:"hidden"}}><div style={{height:"100%",width:`${t.spreadFactor*100}%`,background:t.spreadFactor>0.7?"#27ae60":"#e67e22",borderRadius:"3px"}}/></div><span style={{fontSize:"9px",fontWeight:600,color:t.spreadFactor>0.7?"#27ae60":"#e67e22"}}>{t.spreadFactor}</span></div><div style={{textAlign:"center",fontWeight:800,fontSize:"14px",color:"#2980b9"}}>{t.optimalWeekly}</div><div style={{textAlign:"center",fontWeight:800,fontSize:"14px",color:"#8e44ad"}}>{t.optimalTermly}</div></div>);})}</div><button style={{...bS,marginTop:"12px"}} onClick={()=>dlCSV("allocations.csv",mkCSV(["Name","Subject","Frees","Spread","Weekly","Termly"],optimizerData.map(t=>[t.name,t.subject,t.totalFrees,t.spreadFactor,t.optimalWeekly,t.optimalTermly])))}>📤 Export</button></div></div>);};

  // ═══ STATS ═══
  const renderStats=()=>{const vPl=(v)=>({padding:"5px 14px",border:"none",cursor:"pointer",borderRadius:"6px",background:statsView===v?"#1a3a5c":"transparent",color:statsView===v?"#fff":"#1a3a5c",fontWeight:600,fontSize:"12px",fontFamily:"'DM Sans',sans-serif"});const getCount=(tid)=>{if(statsView==="week")return gwc(tid,selectedStatWeek);if(statsView==="month")return gMonC(tid,selectedStatMonth);if(statsView==="term")return gTermC(tid,selectedStatTerm||curTerm());return 0;};const getMax=(tid)=>{if(statsView==="week")return gmc(tid);if(statsView==="month")return gmc(tid)*4;if(statsView==="term"){const t=terms.find(x=>x.name===(selectedStatTerm||curTerm()));return gmc(tid)*(t?(t.endWeek-t.startWeek+1):7);}return gmc(tid);};const ts2=teachers.map(t=>{const count=getCount(t.id),max=getMax(t.id),pct=max>0?(count/max)*100:0;return{...t,count,max,pct,totalAll:coverHistory.filter(h=>h.teacherId===t.id).length};}).sort((a,b)=>b.count-a.count);const totalC=ts2.reduce((a,t)=>a+t.count,0);const sortedH=[...coverHistory].sort((a,b)=>b.timestamp-a.timestamp);
    return(<div><div style={{marginBottom:"16px"}}><h3 style={{margin:0,fontSize:"18px",fontWeight:800,color:"#1a3a5c"}}>📊 Cover Statistics</h3><p style={{margin:"4px 0",fontSize:"12px",color:"#7a8a9a"}}>All cover data persists across sessions — {coverHistory.length} total records ({getStorageSize()}KB stored)</p></div>
      <div style={{...cd,marginBottom:"16px",padding:"14px 20px"}}><div style={{display:"flex",gap:"10px",alignItems:"center",flexWrap:"wrap"}}><div style={{display:"flex",background:"#f0f4f8",borderRadius:"8px",overflow:"hidden"}}><button style={vPl("week")} onClick={()=>setStatsView("week")}>Week</button><button style={vPl("month")} onClick={()=>setStatsView("month")}>Month</button><button style={vPl("term")} onClick={()=>setStatsView("term")}>Term</button></div>{statsView==="week"&&<select style={sl} value={selectedStatWeek} onChange={e=>setSelectedStatWeek(parseInt(e.target.value))}>{Array.from({length:52},(_,i)=><option key={i+1} value={i+1}>Week {i+1}{i+1===currentWeek?" ●":""}</option>)}</select>}{statsView==="month"&&<select style={sl} value={selectedStatMonth} onChange={e=>setSelectedStatMonth(e.target.value)}>{MONTHS.map(m=><option key={m}>{m}</option>)}</select>}{statsView==="term"&&terms.length>0&&<select style={sl} value={selectedStatTerm||curTerm()} onChange={e=>setSelectedStatTerm(e.target.value)}>{terms.map(t=><option key={t.name}>{t.name}</option>)}</select>}</div></div>
      <div style={{display:"grid",gridTemplateColumns:"repeat(4,1fr)",gap:"12px",marginBottom:"16px"}}>{[{l:"Covers",v:totalC,c:"#2980b9"},{l:"Avg/Teacher",v:teachers.length?(totalC/teachers.length).toFixed(1):"0",c:"#27ae60"},{l:"All-Time",v:coverHistory.length,c:"#1a3a5c"},{l:"Most Used",v:ts2[0]?`${ts2[0].name.split(" ").pop()} (${ts2[0].count})`:"—",c:"#e67e22"}].map((s,i)=><div key={i} style={{...cd,textAlign:"center",borderTop:`3px solid ${s.c}`}}><div style={{fontSize:"9px",color:"#7a8a9a"}}>{s.l}</div><div style={{fontSize:"20px",fontWeight:800,color:s.c}}>{s.v}</div></div>)}</div>
      <div style={{...cd,marginBottom:"16px"}}><h4 style={{margin:"0 0 10px",fontSize:"13px",fontWeight:700}}>Per Teacher</h4><div style={{display:"flex",flexDirection:"column",gap:"4px"}}>{ts2.map(t=>{const col=t.pct>=100?"#c0392b":t.pct>66?"#e67e22":"#27ae60";return(<div key={t.id} style={{display:"grid",gridTemplateColumns:"150px 1fr 50px 50px 50px",gap:"6px",alignItems:"center",padding:"6px 8px",borderRadius:"6px",background:t.count>0?"#fafcff":"#fafbfc",border:"1px solid #eee"}}><div><div style={{fontWeight:700,fontSize:"12px",color:"#1a3a5c"}}>{t.name}</div><div style={{fontSize:"9px",color:"#7a8a9a"}}>{t.subject}</div></div><div style={{display:"flex",alignItems:"center",gap:"6px"}}><div style={{flex:1,height:"8px",background:"#e8ecf0",borderRadius:"4px",overflow:"hidden"}}><div style={{height:"100%",width:`${Math.min(t.pct,100)}%`,background:col,borderRadius:"4px"}}/></div><span style={{fontSize:"10px",fontWeight:600,color:col}}>{t.pct.toFixed(0)}%</span></div><div style={{textAlign:"center",fontWeight:800,fontSize:"14px",color:t.count>0?col:"#ccc"}}>{t.count}</div><div style={{textAlign:"center",fontSize:"12px",color:"#7a8a9a"}}>{t.max}</div><div style={{textAlign:"center",fontSize:"12px",fontWeight:600,color:"#1a3a5c"}}>{t.totalAll}</div></div>);})}</div></div>
      <div style={{...cd}}><div style={{display:"flex",justifyContent:"space-between",alignItems:"center",marginBottom:"10px"}}><h4 style={{margin:0,fontSize:"13px",fontWeight:700}}>📋 History ({coverHistory.length})</h4><div style={{display:"flex",gap:"6px"}}><button style={bS} onClick={()=>dlCSV("cover_history.csv",mkCSV(["Teacher","Day","Period","Class","Week","Month","Term","Time"],coverHistory.map(h=>[gt(h.teacherId)?.name||"?",h.day,h.period,h.class,h.week,h.month||"",h.term||"",new Date(h.timestamp).toLocaleString()])))}>📤 Export</button>{coverHistory.length>0&&<button style={{...bS,color:"#c0392b",borderColor:"#f0c5c5"}} onClick={()=>{if(window.confirm("Clear all cover history?")){setCoverHistory([]);setImportSuccess("History cleared.");setTimeout(()=>setImportSuccess(null),3000);}}}>🗑</button>}</div></div>{!sortedH.length?<div style={{textAlign:"center",padding:"20px",color:"#999"}}>No history yet</div>:<div style={{maxHeight:"260px",overflowY:"auto"}}>{sortedH.slice(0,50).map((h,i)=><div key={i} style={{display:"flex",gap:"6px",alignItems:"center",padding:"4px 8px",borderRadius:"4px",background:i%2===0?"#fafbfc":"#fff",fontSize:"11px"}}><span style={{fontWeight:700,color:"#1a3a5c",minWidth:"100px"}}>{gt(h.teacherId)?.name||"?"}</span><span style={bdg("#e8f0f8","#1a3a5c")}>{h.day}</span><span style={bdg("#f0f4f8","#333")}>{h.period}</span><span style={{color:"#5a6a7a"}}>→ {h.class}</span><span style={{color:"#999",marginLeft:"auto",fontSize:"10px"}}>W{h.week}{h.month?` · ${h.month}`:""}</span></div>)}{sortedH.length>50&&<div style={{textAlign:"center",padding:"6px",fontSize:"10px",color:"#999"}}>+{sortedH.length-50} more — export for full data</div>}</div>}</div>
    </div>);};

  const renderTimetable=()=>(<div><div style={{display:"flex",gap:"8px",marginBottom:"12px",alignItems:"center",flexWrap:"wrap",justifyContent:"space-between"}}><div style={{display:"flex",gap:"8px",alignItems:"center",flexWrap:"wrap"}}><div style={{display:"flex",background:"#f0f4f8",borderRadius:"8px",overflow:"hidden"}}>{["class","teacher"].map(m=><button key={m} onClick={()=>setViewMode(m)} style={pl(viewMode===m)}>{m==="class"?"Class":"Teacher"}</button>)}</div>{viewMode==="class"?<select style={sl} value={selectedClass} onChange={e=>setSelectedClass(e.target.value)}>{classes.map(c=><option key={c}>{c}</option>)}</select>:<select style={sl} value={selectedTeacher} onChange={e=>setSelectedTeacher(parseInt(e.target.value))}>{teachers.map(t=><option key={t.id} value={t.id}>{t.name}</option>)}</select>}</div><button style={bS} onClick={()=>{const r=[];Object.entries(timetable).forEach(([c,ds])=>{Object.entries(ds).forEach(([d,ps])=>{Object.entries(ps).forEach(([p,l])=>{r.push([c,d,p,l.subject,gt(l.teacher)?.name||"?",l.room]);});});});dlCSV("timetable.csv",mkCSV(["Class","Day","Period","Subject","Teacher","Room"],r));}}>📤</button></div><div style={{...cd,overflow:"auto"}}><table style={{width:"100%",borderCollapse:"separate",borderSpacing:"3px",minWidth:`${days.length*110+70}px`}}><thead><tr><th style={{padding:"6px",fontSize:"10px",color:"#7a8a9a",textAlign:"left",width:"60px"}}>Period</th>{days.map(d=><th key={d} style={{padding:"6px",fontSize:"10px",color:"#1a3a5c",fontWeight:700,textAlign:"center"}}>{d}</th>)}</tr></thead><tbody>{periods.map(p=><tr key={p}><td style={{padding:"4px 6px"}}><div style={{fontWeight:700,color:"#1a3a5c",fontSize:"11px"}}>{p}</div>{periodTimes[p]&&<div style={{fontSize:"8px",color:"#999"}}>{periodTimes[p]}</div>}</td>{days.map(d=>{let lesson=null,cls=selectedClass;if(viewMode==="class")lesson=timetable[selectedClass]?.[d]?.[p];else{for(const c of classes){const l=timetable[c]?.[d]?.[p];if(l&&l.teacher===selectedTeacher){lesson=l;cls=c;break;}}}const isA=lesson&&absences.some(a=>a.teacherId===lesson.teacher&&a.day===d&&a.periods.includes(p));const ck=`${d}-${p}-${cls}`,cid=coverAssignments[ck],ct=cid?gt(cid):null;const isE=editingCell===`${cls}-${d}-${p}`;if(!lesson)return<td key={d} style={{padding:"6px",textAlign:"center",borderRadius:"6px",background:"#fafbfc",color:"#ccc",fontSize:"10px"}}>Free</td>;return(<td key={d} style={{padding:0,borderRadius:"6px",overflow:"hidden",cursor:viewMode==="class"?"pointer":"default"}} onClick={()=>{if(viewMode==="class"&&!isE)setEditingCell(`${cls}-${d}-${p}`);}}><div style={{padding:"6px 8px",minHeight:"44px",background:isA?(ct?"#e8f8ee":"#fde8e8"):subjectColors[lesson.subject]||"#f5f5f5",borderLeft:isA?`3px solid ${ct?"#27ae60":"#c0392b"}`:"3px solid transparent"}}>{isE?<div style={{display:"flex",flexDirection:"column",gap:"2px"}} onClick={e=>e.stopPropagation()}><select style={{...sl,padding:"2px",fontSize:"9px"}} value={lesson.subject} onChange={e=>{setTimetable(prev=>({...prev,[cls]:{...prev[cls],[d]:{...prev[cls][d],[p]:{...prev[cls][d][p],subject:e.target.value}}}}));setEditingCell(null);}}>{subjects.map(s=><option key={s}>{s}</option>)}</select><select style={{...sl,padding:"2px",fontSize:"9px"}} value={lesson.teacher} onChange={e=>{setTimetable(prev=>({...prev,[cls]:{...prev[cls],[d]:{...prev[cls][d],[p]:{...prev[cls][d][p],teacher:parseInt(e.target.value)}}}}));setEditingCell(null);}}>{teachers.map(t=><option key={t.id} value={t.id}>{t.name}</option>)}</select></div>:<><div style={{fontWeight:700,fontSize:"10px",color:"#1a3a5c"}}>{lesson.subject}</div><div style={{fontSize:"9px",color:"#5a6a7a"}}>{isA?<span style={{color:"#c0392b",textDecoration:"line-through"}}>{gt(lesson.teacher)?.name}</span>:gt(lesson.teacher)?.name}</div>{ct&&<div style={{fontSize:"9px",color:"#27ae60",fontWeight:600}}>→ {ct.name}</div>}</>}</div></td>);})}</tr>)}</tbody></table></div></div>);

  const renderTeachers=()=>(<div><div style={{display:"flex",justifyContent:"space-between",marginBottom:"12px",flexWrap:"wrap",gap:"6px"}}><h3 style={{margin:0,color:"#1a3a5c"}}>Staff ({teachers.length})</h3><div style={{display:"flex",gap:"6px"}}><button style={bS} onClick={()=>dlCSV("teachers.csv",mkCSV(["Name","Subject","Code"],teachers.map(t=>[t.name,t.subject,t.code||""])))}>📤</button><button style={bP} onClick={()=>setShowAddTeacher(true)}>+ Add</button></div></div>{showAddTeacher&&<div style={{...cd,marginBottom:"12px",background:"#f8fafc"}}><div style={{display:"flex",gap:"8px",alignItems:"flex-end",flexWrap:"wrap"}}><div style={{flex:1,minWidth:"120px"}}><label style={{fontSize:"10px",fontWeight:600,color:"#7a8a9a"}}>Name</label><input style={{...sl,width:"100%",boxSizing:"border-box"}} value={newTeacher.name} onChange={e=>setNewTeacher(p=>({...p,name:e.target.value}))}/></div><div><select style={sl} value={newTeacher.subject} onChange={e=>setNewTeacher(p=>({...p,subject:e.target.value}))}>{subjects.map(s=><option key={s}>{s}</option>)}</select></div><button style={bP} onClick={addTeacher}>Add</button><button style={bS} onClick={()=>setShowAddTeacher(false)}>Cancel</button></div></div>}<div style={{display:"grid",gridTemplateColumns:"repeat(auto-fill,minmax(220px,1fr))",gap:"6px"}}>{teachers.map(t=>{const isA=absences.some(a=>a.teacherId===t.id),wc=gwc(t.id,currentWeek),mc=gmc(t.id);return(<div key={t.id} style={{...cd,padding:"10px",display:"flex",justifyContent:"space-between",alignItems:"center",borderLeft:`3px solid ${isA?"#c0392b":"#27ae60"}`}}><div><div style={{fontWeight:700,color:"#1a3a5c",fontSize:"12px"}}>{t.name}</div><div style={{display:"flex",gap:"3px",marginTop:"2px"}}><span style={bdg(subjectColors[t.subject]||"#eee","#333")}>{t.subject}</span>{t.code&&<span style={bdg("#e0f0ff","#2980b9")}>{t.code}</span>}{isA&&<span style={bdg("#fde8e8","#c0392b")}>Absent</span>}<span style={bdg(wc>=mc?"#fde8e8":"#e8f8ee",wc>=mc?"#c0392b":"#27ae60")}>{wc}/{mc}</span></div></div><button style={bD} onClick={()=>setTeachers(p=>p.filter(x=>x.id!==t.id))}>×</button></div>);})}</div></div>);

  const renderAbsences=()=>(<div><div style={{display:"flex",justifyContent:"space-between",marginBottom:"12px"}}><h3 style={{margin:0,color:"#1a3a5c"}}>Absences</h3><button style={bP} onClick={()=>{setNewAbsence({teacherId:teachers[0]?.id||0,day:days[0]||"",periods:[]});setShowAddAbsence(true);}}>+ Report</button></div>{showAddAbsence&&<div style={{...cd,marginBottom:"12px",background:"#f8fafc"}}><div style={{display:"flex",gap:"10px",flexWrap:"wrap",marginBottom:"8px"}}><div><label style={{fontSize:"10px",fontWeight:600,color:"#7a8a9a"}}>Teacher</label><br/><select style={sl} value={newAbsence.teacherId} onChange={e=>setNewAbsence(p=>({...p,teacherId:parseInt(e.target.value)}))}>{teachers.map(t=><option key={t.id} value={t.id}>{t.name}</option>)}</select></div><div><label style={{fontSize:"10px",fontWeight:600,color:"#7a8a9a"}}>Day</label><br/><select style={sl} value={newAbsence.day} onChange={e=>setNewAbsence(p=>({...p,day:e.target.value}))}>{days.map(d=><option key={d}>{d}</option>)}</select></div></div><div style={{marginBottom:"8px"}}><div style={{display:"flex",gap:"4px",flexWrap:"wrap"}}>{periods.map(p=><button key={p} onClick={()=>setNewAbsence(prev=>({...prev,periods:prev.periods.includes(p)?prev.periods.filter(x=>x!==p):[...prev.periods,p]}))} style={{padding:"4px 10px",borderRadius:"6px",cursor:"pointer",fontWeight:600,fontSize:"11px",fontFamily:"'DM Sans',sans-serif",border:newAbsence.periods.includes(p)?"2px solid #1a3a5c":"2px solid #d0d8e0",background:newAbsence.periods.includes(p)?"#1a3a5c":"#fff",color:newAbsence.periods.includes(p)?"#fff":"#1a3a5c"}}>{p}</button>)}<button style={{...bS,fontSize:"10px"}} onClick={()=>setNewAbsence(p=>({...p,periods:p.periods.length===periods.length?[]:[...periods]}))}>{newAbsence.periods.length===periods.length?"Clear":"All"}</button></div></div><div style={{display:"flex",gap:"6px"}}><button style={bP} onClick={addAbsence}>Save</button><button style={bS} onClick={()=>setShowAddAbsence(false)}>Cancel</button></div></div>}{!absences.length?<div style={{...cd,textAlign:"center",padding:"24px"}}><div style={{fontSize:"32px"}}>🎉</div><div style={{fontWeight:600,color:"#7a8a9a",marginTop:"4px"}}>None</div></div>:<div style={{display:"flex",flexDirection:"column",gap:"4px"}}>{absences.map(a=>{const t=gt(a.teacherId);return<div key={a.id} style={{...cd,padding:"10px",display:"flex",justifyContent:"space-between",alignItems:"center",borderLeft:"3px solid #e67e22"}}><div style={{display:"flex",gap:"8px",alignItems:"center",flexWrap:"wrap"}}><span style={{fontWeight:700,color:"#1a3a5c"}}>{t?.name||"?"}</span><span style={bdg("#fff3e0","#e67e22")}>{a.day}</span><div style={{display:"flex",gap:"2px"}}>{a.periods.map(p=><span key={p} style={bdg("#f0f4f8","#1a3a5c")}>{p}</span>)}</div></div><button style={bD} onClick={()=>removeAbsence(a.id)}>×</button></div>;})}</div>}</div>);

  return(<div style={{fontFamily:"'DM Sans',sans-serif",background:"#f4f6f9",minHeight:"100vh",color:"#2c3e50"}}>
    <link href="https://fonts.googleapis.com/css2?family=DM+Sans:wght@400;500;600;700;800&display=swap" rel="stylesheet"/>
    {importSuccess&&<div style={{position:"fixed",top:"20px",right:"20px",zIndex:2000,background:"#27ae60",color:"#fff",padding:"12px 20px",borderRadius:"10px",fontWeight:600,fontSize:"13px",boxShadow:"0 8px 30px rgba(39,174,96,0.3)"}}>✓ {importSuccess}</div>}
    <header style={{background:"#1a3a5c",padding:"14px 24px",display:"flex",justifyContent:"space-between",alignItems:"center"}}>
      <div><h1 style={{margin:0,fontSize:"18px",fontWeight:800,color:"#fff"}}>📋 CoverBoard{schoolName?` — ${schoolName}`:""}</h1><p style={{margin:"2px 0 0",fontSize:"10px",color:"rgba(255,255,255,0.5)"}}>{teachers.length} staff · {classes.length} classes · {days.length} days · {periods.length} periods</p></div>
      <div style={{display:"flex",gap:"6px",alignItems:"center"}}><span style={bdg("rgba(39,174,96,0.25)","#8cffb8")}>FREE</span><span style={bdg("rgba(142,68,173,0.25)","#d0a0ff")}>PREMIUM</span><span style={bdg("rgba(230,126,34,0.25)","#ffcf8f")}>INTEL</span>
        <button style={{background:"rgba(255,255,255,0.1)",border:"1px solid rgba(255,255,255,0.2)",borderRadius:"6px",padding:"4px 10px",cursor:"pointer",color:"rgba(255,255,255,0.7)",fontSize:"10px",fontFamily:"'DM Sans',sans-serif"}} onClick={resetAllData}>Reset</button></div>
    </header>
    <nav style={{background:"#fff",padding:"0 16px",display:"flex",gap:"1px",borderBottom:"1px solid #e8ecf0",overflowX:"auto"}}>
      {[{id:"dashboard",label:"Dashboard"},{id:"timetable",label:"Timetable"},{id:"teachers",label:"Teachers"},{id:"absences",label:"Absences"},{id:"free",label:"📋 Free"},{id:"premium",label:"⚡ Premium"},{id:"intelligence",label:"🧠 Intel"},{id:"optimizer",label:"📐 Optimizer"},{id:"stats",label:"📊 Stats"}].map(tab=>(<button key={tab.id} style={tbs(tab.id)} onClick={()=>setActiveTab(tab.id)}>{tab.label}{tab.id==="absences"&&absences.length>0&&<span style={{marginLeft:"3px",...bdg("#e67e22","#fff")}}>{absences.length}</span>}{tab.id==="dashboard"&&uncoveredLessons.length>0&&<span style={{marginLeft:"3px",...bdg("#c0392b","#fff")}}>{uncoveredLessons.length}</span>}{tab.id==="stats"&&coverHistory.length>0&&<span style={{marginLeft:"3px",...bdg("#2980b9","#fff")}}>{coverHistory.length}</span>}</button>))}
    </nav>
    <main style={{padding:"20px 24px",maxWidth:"1200px",margin:"0 auto"}}>
      {activeTab==="dashboard"&&renderDashboard()}
      {activeTab==="timetable"&&renderTimetable()}
      {activeTab==="teachers"&&renderTeachers()}
      {activeTab==="absences"&&renderAbsences()}
      {activeTab==="free"&&renderFree()}
      {activeTab==="premium"&&renderPremium()}
      {activeTab==="intelligence"&&renderIntelligence()}
      {activeTab==="optimizer"&&renderOptimizer()}
      {activeTab==="stats"&&renderStats()}
    </main>
  </div>);
}
