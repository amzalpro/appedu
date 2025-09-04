// Firebase Configuration
const appId = window.__app_id || 'DEFAULT_APP_ID';
const firebaseConfig = window.__firebase_config || {
    apiKey: "AIza...",
    authDomain: "your-project.firebaseapp.com",
    projectId: "your-project",
    storageBucket: "your-project.appspot.com",
    messagingSenderId: "12345",
    appId: "1:12345:web:abcdef"
};
const initialAuthTokenFromEnv = window.__initial_auth_token;

// Local Persistence Configuration
const APP_DATA_KEY = 'schoolManagementAppData';

// Import Firebase functions from CDN
import { initializeApp } from "https://www.gstatic.com/firebasejs/11.6.1/firebase-app.js";
import { getAuth, signInAnonymously, onAuthStateChanged, signInWithCustomToken } from "https://www.gstatic.com/firebasejs/11.6.1/firebase-auth.js";
import { getFirestore, doc, getDoc, setDoc, addDoc, updateDoc, deleteDoc, onSnapshot, collection, query, where, writeBatch, getDocs, Timestamp, enableIndexedDbPersistence, setLogLevel } from "https://www.gstatic.com/firebasejs/11.6.1/firebase-firestore.js";

// Initialize Firebase
const app = initializeApp(firebaseConfig);
const auth = getAuth(app);
const db = getFirestore(app);

// Enable offline persistence
try {
    await enableIndexedDbPersistence(db);
} catch (err) {
    if (err.code == 'failed-precondition') {
        console.warn("Multiple tabs open, persistence can only be enabled in one tab at a time.");
    } else if (err.code == 'unimplemented') {
        console.warn("The current browser does not support all of the features required to enable persistence.");
    }
}

// Global State
let currentEditingId = null;
let currentUserId = null;
let unsubscribers = [];
let selectedDeskForAssignment = null;
let currentSeatingArrangement = {};
let currentGradeContext = {};
let weekOffset = 0;
let icalEvents = []; // To store events from iCal URL

const appState = {
    classes: [], students: [], groups: [], evaluations: [], student_grades: [],
    absences: [], timetable_slots: [], skills: [], acquisition_levels: [],
    rooms: [], seating_charts: [],
    subjects: ["Français", "Mathématiques", "Histoire", "Géographie", "Sciences", "Anglais", "EPS", "Arts"],
    periods: ["Trimestre 1", "Trimestre 2", "Trimestre 3"],
    timetable_lessons: [], // {day,start,end,subject,classId,room,teacher,weeks?}
    icalUrl: "",
};

// --- AUTHENTICATION ---
onAuthStateChanged(auth, (user) => {
    // Force local mode: no remote listeners, keep local data stable
    const userInfoEl = document.getElementById('userInfo');
    userInfoEl.textContent = 'Mode local';
    currentUserId = 'local';
    initializeAppData();
    updateDashboard();
    updateSubjectsTable();
    updatePeriodsTable();
    loadIcalUrl();
});

// --- DATA INITIALIZATION & LISTENERS ---
function getCollectionPath(collectionName) {
    return `artifacts/${appId}/public/data/${collectionName}`;
}

function initializeDataListeners() {
    clearDataAndListeners();
    const collectionsToListen = [
        'classes', 'students', 'groups', 'evaluations', 'student_grades',
        'absences', 'timetable_slots', 'skills', 'acquisition_levels',
        'rooms', 'seating_charts'
    ];

    collectionsToListen.forEach(collectionName => {
        const q = query(collection(db, getCollectionPath(collectionName)));
        const unsubscribe = onSnapshot(q, (querySnapshot) => {
            appState[collectionName] = [];
            querySnapshot.forEach((doc) => {
                appState[collectionName].push({ id: doc.id, ...doc.data() });
            });
            
            // Specific updates after data fetch
            switch(collectionName) {
                case 'classes': updateClassesTable(); updateAllFilters(); break;
                case 'students': updateStudentsTable(); break;
                case 'groups': updateGroupsTable(); break;
                case 'evaluations': case 'student_grades': if (currentGradeContext.targetId) loadGradeTable(); break;
                case 'absences': updateAbsencesTable(); break;
                case 'timetable_slots': updateTimetableSlotsTable(); break;
                case 'skills': updateSkillsTable(); populateSubjectFilterForSkills(); break;
                case 'acquisition_levels': updateAcquisitionLevelsTable(); break;
                case 'rooms': updateRoomsTable(); break;
                case 'seating_charts': updateSeatingChartsTable(); break;
            }
            updateDashboard();
        }, (error) => {
            console.error(`Error listening to ${collectionName}:`, error);
            showAlert(`Erreur de synchronisation (${collectionName})`, 'danger');
        });
        unsubscribers.push(unsubscribe);
    });
}

function clearDataAndListeners() {
    unsubscribers.forEach(unsub => unsub());
    unsubscribers = [];
    Object.keys(appState).forEach(key => {
         if(Array.isArray(appState[key])) appState[key] = [];
    });
}

// --- DATA PERSISTENCE ---

async function loadDataFromJsonFile() {
    try {
        const res = await fetch('./data.json', { cache: 'no-cache' });
        if (!res.ok) return;
        const fileData = await res.json();
        Object.keys(appState).forEach(k => {
            if (fileData[k] !== undefined) appState[k] = fileData[k];
        });
    } catch (e) {
        console.warn('Aucun data.json lisible, utilisation des données par défaut.', e);
    }
}

async function saveDataToLocalStorage() {
    // Remplace la persistance locale par l'écriture vers data.json
    const json = JSON.stringify(appState, null, 2);
    // Tentative via File System Access API si disponible
    if (window.showSaveFilePicker) {
        try {
            if (!window.__dataFileHandle) {
                window.__dataFileHandle = await window.showSaveFilePicker({
                    suggestedName: 'data.json',
                    types: [{ description: 'JSON', accept: { 'application/json': ['.json'] } }],
                });
            }
            const writable = await window.__dataFileHandle.createWritable();
            await writable.write(json);
            await writable.close();
            showAlert('Données sauvegardées dans data.json', 'success');
            return;
        } catch (e) {
            console.warn('Écriture via File System Access refusée/échouée, fallback téléchargement.', e);
        }
    }
    // Fallback: téléchargement d’un fichier data.json
    downloadFile('data.json', json, 'application/json');
    showAlert('Fichier data.json téléchargé (enregistrez-le dans le dossier de l\'app).', 'info');
}

function loadDataFromLocalStorage() {
    const data = localStorage.getItem(APP_DATA_KEY);
    if (data) {
        try {
            const parsedData = JSON.parse(data);
            // Simple migration: ensure all keys from default appState exist
            Object.keys(appState).forEach(key => {
                if (parsedData[key] !== undefined) {
                    appState[key] = parsedData[key];
                }
            });
        } catch (error) {
            console.error("Error parsing data from localStorage:", error);
            showAlert("Impossible de charger les données locales, elles pourraient être corrompues.", "warning");
        }
    }
}

function initializeAppData() {
    loadDataFromLocalStorage(); // rétro-compatibilité si data.json absent
    // Initial UI render
    updateClassesTable();
    updateStudentsTable();
    updateGroupsTable();
    updateAbsencesTable();
    updateTimetableSlotsTable();
    updateSkillsTable();
    populateSubjectFilterForSkills();
    updateAcquisitionLevelsTable();
    updateRoomsTable();
    updateSeatingChartsTable();
    updateAllFilters();
    updateDashboard();
    updateSubjectsTable();
    updatePeriodsTable();
}

function generateId() {
    return crypto.randomUUID();
}

// --- UI & UTILS ---

function toggleTheme() {
    const currentTheme = document.documentElement.getAttribute('data-theme');
    const newTheme = currentTheme === 'dark' ? 'light' : 'dark';
    document.documentElement.setAttribute('data-theme', newTheme);
    localStorage.setItem('theme', newTheme);
    document.querySelector('#theme-toggle-btn i').className = `fas fa-${newTheme === 'dark' ? 'sun' : 'moon'}`;
}
window.toggleTheme = toggleTheme;

function loadTheme() {
    const savedTheme = localStorage.getItem('theme') || 'light';
    document.documentElement.setAttribute('data-theme', savedTheme);
    document.querySelector('#theme-toggle-btn i').className = `fas fa-${savedTheme === 'dark' ? 'sun' : 'moon'}`;
}

function switchTab(event, tabName) {
    document.querySelectorAll('.tab-content').forEach(tc => tc.classList.remove('active'));
    document.getElementById(tabName).classList.add('active');
    document.querySelectorAll('.nav-tab').forEach(nt => nt.classList.remove('active'));
    event.currentTarget.classList.add('active');
}
window.switchTab = switchTab;

function openModal(modalId) { 
    const form = document.getElementById(modalId).querySelector('form');
    if(form) form.reset();
    currentEditingId = null;
    document.getElementById(modalId).classList.add('open'); 
}
window.openModal = openModal;

function closeModal(modalId) { 
    const modal = document.getElementById(modalId);
    modal.classList.remove('open');
    // Reset form inside modal if exists
    const form = modal.querySelector('form');
    if(form) form.reset();
    currentEditingId = null;
}
window.closeModal = closeModal;

let confirmCallback = null;
function showConfirmationModal(message, callback) {
    document.getElementById('confirmationMessage').textContent = message;
    confirmCallback = callback;
    openModal('confirmationModal');
}
window.showConfirmationModal = showConfirmationModal;

document.getElementById('confirmOkBtn').addEventListener('click', () => {
    if (typeof confirmCallback === 'function') confirmCallback();
    closeModal('confirmationModal');
});
document.getElementById('confirmCancelBtn').addEventListener('click', () => closeModal('confirmationModal'));

function showAlert(message, type = 'info', duration = 3000) {
    const container = document.getElementById('alertContainer');
    const alert = document.createElement('div');
    alert.className = `alert alert-${type}`;
    alert.textContent = message;
    container.appendChild(alert);
    setTimeout(() => {
        alert.style.opacity = '0';
        setTimeout(() => alert.remove(), 300);
    }, duration);
}

function formatDate(dateString) {
     if (!dateString) return '';
     // Handles both Date objects and ISO strings
     const d = new Date(dateString);
     return d.toLocaleDateString('fr-FR');
}

function dateToYMD(date) {
    const d = new Date(date);
    const year = d.getFullYear();
    const month = String(d.getMonth() + 1).padStart(2, '0');
    const day = String(d.getDate()).padStart(2, '0');
    return `${year}-${month}-${day}`;
}

function downloadFile(filename, content, contentType) {
    const blob = new Blob([content], { type: contentType });
    const a = document.createElement('a');
    a.href = URL.createObjectURL(blob);
    a.download = filename;
    document.body.appendChild(a);
    a.click();
    document.body.removeChild(a);
    URL.revokeObjectURL(a.href);
}

function populateSelectWithOptions(selectId, options, placeholder = '', valueKey = 'id', nameKey = 'name') {
    const select = document.getElementById(selectId);
    select.innerHTML = `<option value="">${placeholder}</option>`;
    options.forEach(option => {
        select.innerHTML += `<option value="${option[valueKey]}">${option[nameKey]}</option>`;
    });
}

// --- DATA IMPORT/EXPORT ---
function exportDataAsJson() {
    try {
        const jsonContent = JSON.stringify(appState, null, 2);
        const date = new Date().toISOString().slice(0, 10);
        downloadFile(`sauvegarde-gestion-scolaire-${date}.json`, jsonContent, 'application/json');
        showAlert('Exportation réussie !', 'success');
    } catch (error) {
        console.error("Error exporting data:", error);
        showAlert("Erreur lors de l'exportation des données.", "danger");
    }
}
window.exportDataAsJson = exportDataAsJson;

function importDataFromJson(event) {
    const file = event.target.files[0];
    if (!file) return;

    const reader = new FileReader();
    reader.onload = (e) => {
        const text = e.target.result;
        try {
            const importedData = JSON.parse(text);
            showConfirmationModal("L'importation de ce fichier écrasera toutes les données actuelles. Voulez-vous continuer ?", () => {
                Object.keys(appState).forEach(key => {
                    appState[key] = importedData[key] || appState[key];
                });
                saveDataToLocalStorage();
                showAlert('Données importées avec succès. Rechargement de l\'application.', 'success');
                setTimeout(() => location.reload(), 1500);
            });
        } catch (error) {
            showAlert("Erreur lors de la lecture du fichier. Assurez-vous qu'il s'agit d'un fichier JSON valide.", "danger");
            console.error("JSON Parse Error:", error);
        } finally {
            // Reset file input to allow re-importing the same file
            event.target.value = '';
        }
    };
    reader.readAsText(file);
}
window.importDataFromJson = importDataFromJson;

function importTimetableLessonsFromJson(event){
    const file = event.target.files[0]; if(!file) return;
    const reader = new FileReader();
    reader.onload = e => {
        try {
            const data = JSON.parse(e.target.result);
            if(!Array.isArray(data)) throw new Error('Format invalide');
            const ok = data.every(l => typeof l.date === 'string' && l.start && l.end);
            if(!ok) throw new Error('Chaque leçon doit contenir "date" (YYYY-MM-DD), "start", "end".');
            appState.timetable_lessons = data; saveDataToLocalStorage();
            updateTimetableDisplay(); showAlert('Emploi du temps importé','success');
        } catch(err){ showAlert('Fichier EDT invalide: utilisez des objets avec "date", "start", "end".','danger'); console.error(err); }
        finally { event.target.value=''; }
    };
    reader.readAsText(file);
}
window.importTimetableLessonsFromJson = importTimetableLessonsFromJson;

// --- DASHBOARD ---
function updateDashboard() {
    const statsGrid = document.getElementById('statsGrid');
    const classesOverview = document.getElementById('classesOverview');
    const todaySchedule = document.getElementById('todaySchedule');
    const recentEvaluations = document.getElementById('recentEvaluations');
    
    if (!statsGrid || !classesOverview || !todaySchedule || !recentEvaluations) return;

    // 1. Stats Grid
    const stats = [
        { label: 'Classes', value: appState.classes.length, icon: 'fa-school', theme: 'classes-stat' },
        { label: 'Élèves', value: appState.students.length, icon: 'fa-user-graduate', theme: 'students-stat' },
        { label: 'Groupes', value: appState.groups.length, icon: 'fa-users', theme: 'groups-stat' },
        { label: 'Évaluations', value: appState.evaluations.length, icon: 'fa-clipboard-list', theme: 'evals-stat' }
    ];

    statsGrid.innerHTML = stats.map(stat => `
        <div class="stat-card ${stat.theme}">
            <div class="stat-content">
                <div class="stat-value">${stat.value}</div>
                <div class="stat-label">${stat.label}</div>
            </div>
            <i class="fas ${stat.icon} stat-icon"></i>
        </div>
    `).join('');

    // Subtle animated counters
    document.querySelectorAll('.stat-value').forEach(el=>{
        const end = parseInt(el.textContent)||0; let c=0; const step = Math.ceil(end/20)||1;
        if(end === 0) return;
        el.textContent = 0;
        clearInterval(el.__timer); el.__timer = setInterval(()=>{ c+=step; if(c>=end){ c=end; clearInterval(el.__timer); } el.textContent=c; }, 20);
    });

    // 2. Classes Overview
    if (appState.classes.length > 0) {
        classesOverview.innerHTML = appState.classes.map(c => `
            <div class="class-overview-item">
                <span class="name">${c.name} <small class="text-muted">${c.level || ''}</small></span>
                <span class="count">${appState.students.filter(s => s.classId === c.id).length} élèves</span>
            </div>
        `).join('');
    } else {
        classesOverview.innerHTML = `<p class="text-muted text-center">Aucune classe créée.</p>`;
    }
    
    // 3. Today's Schedule
    const todayYMD = dateToYMD(new Date());
    const todayLessons = appState.timetable_lessons
        .filter(l => l.date === todayYMD)
        .sort((a,b) => a.start.localeCompare(b.start));

    if (todayLessons.length > 0) {
        todaySchedule.innerHTML = todayLessons.map(l => {
            const className = appState.classes.find(c => c.id === l.classId)?.name || 'N/A';
            return `
                <div class="schedule-item">
                    <div class="time">${l.start} - ${l.end}</div>
                    <div class="details">
                        <div class="subject">${l.subject}</div>
                        <div class="class">${className} ${l.room ? `• Salle ${l.room}` : ''}</div>
                    </div>
                </div>
            `;
        }).join('');
    } else {
        todaySchedule.innerHTML = `<p class="text-muted text-center">Aucun cours prévu pour aujourd'hui.</p>`;
    }

    // 4. Recent Evaluations
    const lastEvals = [...appState.evaluations]
        .sort((a,b) => new Date(b.date) - new Date(a.date))
        .slice(0, 5);
        
    if (lastEvals.length > 0) {
        recentEvaluations.innerHTML = lastEvals.map(ev => {
             const targetName = (ev.targetType === 'class' 
                ? appState.classes.find(c => c.id === ev.targetId)?.name
                : appState.groups.find(g => g.id === ev.targetId)?.name) || 'N/A';
            return `
                 <div class="evaluation-item">
                    <div class="details">
                        <div class="name">${ev.name}</div>
                        <div class="info">${ev.subject} • ${targetName} • ${formatDate(ev.date)}</div>
                    </div>
                </div>
            `;
        }).join('');
    } else {
        recentEvaluations.innerHTML = `<p class="text-muted text-center">Aucune évaluation récente.</p>`;
    }
}

// ** EVALUATIONS & NOTES **
function updateEvaluationFilters() {
    const targetTypeSelect = document.getElementById('gradeTargetTypeFilter');
    const targetSelect = document.getElementById('gradeTargetFilter');
    const currentTargetId = targetSelect.value;
    const currentPeriod = document.getElementById('gradePeriodFilter').value;
    const currentSubject = document.getElementById('gradeSubjectFilter').value;
    
    if (targetTypeSelect.value === 'class') {
        populateSelectWithOptions(targetSelect.id, appState.classes, 'Choisir une classe');
    } else {
        populateSelectWithOptions(targetSelect.id, appState.groups, 'Choisir un groupe');
    }
    targetSelect.value = currentTargetId; // Preserve selection if possible

    populateSelectWithOptions('gradePeriodFilter', appState.periods.map(p => ({id: p, name: p})), 'Choisir une période');
    populateSelectWithOptions('gradeSubjectFilter', appState.subjects.map(s => ({id: s, name: s})), 'Choisir une matière');
    document.getElementById('gradePeriodFilter').value = currentPeriod || '';
    document.getElementById('gradeSubjectFilter').value = currentSubject || '';
}

function updateEvalTargetOptions() {
    const targetType = document.getElementById('evalTargetType').value;
    const targetSelect = document.getElementById('evalTargetId');
    if (targetType === 'class') {
        populateSelectWithOptions(targetSelect.id, appState.classes, 'Choisir une classe');
    } else {
        populateSelectWithOptions(targetSelect.id, appState.groups, 'Choisir un groupe');
    }
}

function toggleEvalTypeFields() {
    const type = document.getElementById('evalType').value;
    const maxPointsContainer = document.getElementById('evalMaxPointsContainer');
    const skillsContainer = document.getElementById('evalSkillsContainer');

    maxPointsContainer.style.display = (type === 'grade' || type === 'grade_skill') ? 'block' : 'none';
    skillsContainer.style.display = (type === 'skill' || type === 'grade_skill') ? 'block' : 'none';
}

function openEvaluationCreatorModal() {
    currentEditingId = null;
    document.getElementById('evaluationForm').reset();
    document.getElementById('evaluationCreatorModal').querySelector('.modal-title').textContent = "Nouvelle évaluation";
    
    populateSelectWithOptions('evalPeriod', appState.periods.map(p => ({id: p, name: p})), 'Choisir une période');
    populateSelectWithOptions('evalSubject', appState.subjects.map(s => ({id: s, name: s})), 'Choisir une matière');
    
    document.getElementById('evalTargetType').onchange = updateEvalTargetOptions;
    document.getElementById('evalType').onchange = toggleEvalTypeFields;
    document.getElementById('evalSubject').onchange = populateSkillsForEvaluationModal;
    
    updateEvalTargetOptions();
    toggleEvalTypeFields();
    populateSkillsForEvaluationModal();
    
    document.getElementById('evalDate').valueAsDate = new Date();

    openModal('evaluationCreatorModal');
}
window.openEvaluationCreatorModal = openEvaluationCreatorModal;

function populateSkillsForEvaluationModal() {
    const subject = document.getElementById('evalSubject').value;
    const skillsContainer = document.getElementById('evaluationSkills');
    const relevantSkills = subject ? appState.skills.filter(s => s.subjects && s.subjects.includes(subject)) : appState.skills;

    skillsContainer.innerHTML = relevantSkills.map(skill => `
        <label>
            <input type="checkbox" name="evalSkills" value="${skill.id}"> ${skill.name}
        </label>
    `).join('');
}

function createEvaluation() {
    const evalType = document.getElementById('evalType').value;
    const skills = (evalType === 'skill' || evalType === 'grade_skill')
        ? Array.from(document.querySelectorAll('[name="evalSkills"]:checked')).map(el => el.value)
        : [];

    const data = {
        name: document.getElementById('evalName').value,
        date: document.getElementById('evalDate').value,
        targetType: document.getElementById('evalTargetType').value,
        targetId: document.getElementById('evalTargetId').value,
        period: document.getElementById('evalPeriod').value,
        subject: document.getElementById('evalSubject').value,
        type: evalType,
        maxPoints: (evalType === 'grade' || evalType === 'grade_skill') ? document.getElementById('evalMaxPoints').value : null,
        coefficient: document.getElementById('evalCoefficient').value,
        isBonus: document.getElementById('evalBonus').checked,
        skillIds: skills,
    };

    if (!data.name || !data.targetId || !data.period || !data.subject) {
        showAlert("Veuillez remplir tous les champs obligatoires.", "warning");
        return;
    }

    data.id = generateId();
    appState.evaluations.push(data);
    
    saveDataToLocalStorage();
    updateDashboard();
    
    if (currentGradeContext.targetId === data.targetId) {
        loadGradeTable();
    }
    closeModal('evaluationCreatorModal');
    showAlert('Évaluation créée avec succès.', 'success');
}
window.createEvaluation = createEvaluation;

function loadGradeTable() {
    const container = document.getElementById('gradeTableContainer');
    const targetType = document.getElementById('gradeTargetTypeFilter').value;
    const targetId = document.getElementById('gradeTargetFilter').value;
    const period = document.getElementById('gradePeriodFilter').value;
    const subject = document.getElementById('gradeSubjectFilter').value;

    currentGradeContext = { targetType, targetId, period, subject };

    if (!targetId || !period || !subject) {
        container.innerHTML = `<p class="text-center text-muted">Sélectionnez une classe/groupe, une période et une matière pour afficher le tableau des notes.</p>`;
        return;
    }

    const students = getStudentsForTarget(targetId, targetType);
    const evaluations = getEvaluationsForContext(targetId, targetType, period, subject);

    if (students.length === 0) {
        container.innerHTML = `<p class="text-center text-muted">Aucun élève trouvé pour cette sélection.</p>`;
        return;
    }

    let tableHTML = `<table class="table grade-table"><thead><tr><th class="student-name-col">Élève</th>`;
    evaluations.forEach(ev => {
        tableHTML += `<th class="eval-header">
            <div>${ev.name}</div>
            <div class="eval-info">${formatDate(ev.date)} - Coeff ${ev.coefficient}</div>
            <div class="eval-delete"><i class="fas fa-trash" onclick="event.stopPropagation(); window.deleteEvaluation('${ev.id}')"></i></div>
        </th>`;
    });
    tableHTML += `<th class="average-col">Moyenne</th></tr></thead><tbody>`;

    students.forEach(student => {
        tableHTML += `<tr><td class="student-name-col">${student.firstName} ${student.lastName}</td>`;
        evaluations.forEach(ev => {
            const grade = appState.student_grades.find(g => g.studentId === student.id && g.evaluationId === ev.id);
            tableHTML += `<td class="grade-cell" onclick="window.openQuickGrade('${student.id}', '${ev.id}')">${formatGradeDisplay(grade, ev)}</td>`;
        });
        tableHTML += `<td class="average-col">--</td>`; // Average calculation placeholder
        tableHTML += `</tr>`;
    });

    tableHTML += `</tbody></table>`;
    container.innerHTML = tableHTML;
}

function getStudentsForTarget(targetId, targetType) {
    if (targetType === 'class') {
        return appState.students.filter(s => s.classId === targetId);
    } else {
        const group = appState.groups.find(g => g.id === targetId);
        if (!group || !group.members) return [];
        return appState.students.filter(s => group.members.includes(s.id));
    }
}

function getEvaluationsForContext(targetId, targetType, period, subject) {
    return appState.evaluations.filter(ev => 
        ev.targetId === targetId &&
        ev.targetType === targetType &&
        ev.period === period &&
        ev.subject === subject
    ).sort((a,b) => new Date(a.date) - new Date(b.date));
}

function formatGradeDisplay(grade, evaluation) {
    if (!grade) return '';
    if (evaluation.type === 'grade' || evaluation.type === 'grade_skill') {
        return grade.value ?? '';
    }
    if (evaluation.type === 'skill') {
        if (grade.skillLevels && Object.keys(grade.skillLevels).length > 0) {
            const levelId = Object.values(grade.skillLevels)[0]; // Show first skill level
            const level = appState.acquisition_levels.find(l => l.id === levelId);
            return level ? level.code : 'Comp.';
        }
        return 'Comp.';
    }
    return '';
}

function deleteEvaluation(id) {
    showConfirmationModal('Supprimer cette évaluation supprimera aussi toutes les notes associées. Continuer ?', () => {
        appState.evaluations = appState.evaluations.filter(ev => ev.id !== id);
        appState.student_grades = appState.student_grades.filter(g => g.evaluationId !== id);
        saveDataToLocalStorage();
        showAlert('Évaluation et notes supprimées.', 'success');
        loadGradeTable(); // Refresh the table
    });
}
window.deleteEvaluation = deleteEvaluation;

function openQuickGrade(studentId, evaluationId) {
    const student = appState.students.find(s => s.id === studentId);
    const evaluation = appState.evaluations.find(ev => ev.id === evaluationId);
    if (!student || !evaluation) return;

    currentEditingId = null; // We are creating/editing a grade, not another entity
    
    document.getElementById('quickGradeForm').reset();
    document.getElementById('quickGradeStudentName').textContent = `${student.firstName} ${student.lastName}`;
    document.getElementById('quickGradeEvalName').textContent = evaluation.name;

    const grade = appState.student_grades.find(g => g.studentId === studentId && g.evaluationId === evaluationId);
    if(grade) {
        currentEditingId = grade.id;
        document.getElementById('quickGradeValue').value = grade.value || '';
        document.getElementById('quickGradeComment').value = grade.comment || '';
    }

    document.getElementById('quickGradeForm').dataset.studentId = studentId;
    document.getElementById('quickGradeForm').dataset.evaluationId = evaluationId;

    openModal('quickGradeModal');
}
window.openQuickGrade = openQuickGrade;

function saveQuickGrade() {
    const studentId = document.getElementById('quickGradeForm').dataset.studentId;
    const evaluationId = document.getElementById('quickGradeForm').dataset.evaluationId;
    
    const data = {
        studentId,
        evaluationId,
        value: document.getElementById('quickGradeValue').value,
        comment: document.getElementById('quickGradeComment').value,
        skillLevels: {} // Placeholder for skill levels UI
    };

    if (currentEditingId) {
        const index = appState.student_grades.findIndex(g => g.id === currentEditingId);
        appState.student_grades[index] = { ...appState.student_grades[index], ...data };
    } else {
        data.id = generateId();
        appState.student_grades.push(data);
    }
    saveDataToLocalStorage();
    loadGradeTable();
    closeModal('quickGradeModal');
    showAlert('Note sauvegardée', 'success');
}
window.saveQuickGrade = saveQuickGrade;

function exportGradesByPeriod() {
    showAlert("La fonction d'exportation est en cours de développement.", "info");
}
window.exportGradesByPeriod = exportGradesByPeriod;

// --- DATA CRUD ---

function deleteItem(collectionName, id) {
    showConfirmationModal(`Êtes-vous sûr de vouloir supprimer cet élément ?`, () => {
        appState[collectionName] = appState[collectionName].filter(item => item.id !== id);
        saveDataToLocalStorage();
        showAlert('Élément supprimé', 'success');
        // Trigger necessary UI updates
        switch (collectionName) {
            case 'classes': updateClassesTable(); updateAllFilters(); break;
            case 'students': updateStudentsTable(); break;
            case 'groups': updateGroupsTable(); updateStudentsTable(); break; // Update students table if a group is deleted
            case 'absences': updateAbsencesTable(); break;
            case 'rooms': updateRoomsTable(); break;
            case 'seating_charts': updateSeatingChartsTable(); break;
            case 'timetable_slots': updateTimetableSlotsTable(); break;
            case 'skills': updateSkillsTable(); break;
            case 'acquisition_levels': updateAcquisitionLevelsTable(); break;
        }
        updateDashboard();
    });
}

// ** ABSENCES **
function updateAbsencesTable() {
    const classFilter = document.getElementById('absenceClassFilter').value;
    const filtered = classFilter === 'all'
        ? appState.absences
        : appState.absences.filter(a => {
            const student = appState.students.find(s => s.id === a.studentId);
            return student && student.classId === classFilter;
        });

    const tbody = document.getElementById('absencesTable');
    tbody.innerHTML = filtered.map(a => {
        const student = appState.students.find(s => s.id === a.studentId);
        const sClass = student ? appState.classes.find(c => c.id === student.classId) : null;
        return `
            <tr>
                <td>${student ? `${student.firstName} ${student.lastName}` : 'N/A'}</td>
                <td>${sClass ? sClass.name : 'N/A'}</td>
                <td>${formatDate(a.date)}</td>
                <td>${a.type}</td>
                <td>${a.reason || ''}</td>
                <td>${a.justified ? 'Oui' : 'Non'}</td>
                <td class="actions">
                     <button class="btn-icon" onclick="window.editAbsence('${a.id}')" title="Modifier"><i class="fas fa-pencil-alt"></i></button>
                     <button class="btn-icon" onclick="window.deleteAbsence('${a.id}')" title="Supprimer"><i class="fas fa-trash"></i></button>
                </td>
            </tr>
        `;
    }).join('');
}
window.updateAbsencesTable = updateAbsencesTable;

function openAbsenceModal() {
    currentEditingId = null;
    document.getElementById('absenceForm').reset();
    document.getElementById('absenceModalTitle').textContent = 'Nouvelle absence';
    const studentSelect = document.getElementById('absenceStudentId');
    studentSelect.innerHTML = '<option value="">Choisir un élève</option>';
    appState.students.sort((a,b) => a.lastName.localeCompare(b.lastName)).forEach(s => {
        studentSelect.innerHTML += `<option value="${s.id}">${s.lastName} ${s.firstName}</option>`;
    });
    document.getElementById('absenceDate').valueAsDate = new Date();
    openModal('absenceModal');
}
window.openAbsenceModal = openAbsenceModal;

function saveAbsence() {
    const data = {
        studentId: document.getElementById('absenceStudentId').value,
        date: document.getElementById('absenceDate').value,
        type: document.getElementById('absenceType').value,
        reason: document.getElementById('absenceReason').value,
        justified: document.getElementById('absenceJustified').checked
    };
    if (currentEditingId) {
        const index = appState.absences.findIndex(a => a.id === currentEditingId);
        appState.absences[index] = { ...appState.absences[index], ...data };
    } else {
        data.id = generateId();
        appState.absences.push(data);
    }
    saveDataToLocalStorage();
    updateAbsencesTable();
    closeModal('absenceModal');
    showAlert('Absence sauvegardée.', 'success');
}
window.saveAbsence = saveAbsence;

function editAbsence(id) {
    const absence = appState.absences.find(a => a.id === id);
    if (!absence) return;
    openAbsenceModal();
    currentEditingId = id;
    document.getElementById('absenceModalTitle').textContent = 'Modifier absence';
    document.getElementById('absenceStudentId').value = absence.studentId;
    document.getElementById('absenceDate').value = absence.date;
    document.getElementById('absenceType').value = absence.type;
    document.getElementById('absenceReason').value = absence.reason;
    document.getElementById('absenceJustified').checked = absence.justified;
}
window.editAbsence = editAbsence;

function deleteAbsence(id) { deleteItem('absences', id); }
window.deleteAbsence = deleteAbsence;

// ** CLASSES **
function updateClassesTable() {
    const tbody = document.getElementById('classesTable');
    if (!tbody) return;
    tbody.innerHTML = appState.classes.map(c => `
        <tr>
            <td>${c.name}</td>
            <td>${c.level || ''}</td>
            <td>${c.year || ''}</td>
            <td>${appState.students.filter(s => s.classId === c.id).length}</td>
            <td class="actions">
                <button class="btn-icon" onclick="window.editClass('${c.id}')" title="Modifier"><i class="fas fa-pencil-alt"></i></button>
                <button class="btn-icon" onclick="window.deleteClass('${c.id}')" title="Supprimer"><i class="fas fa-trash"></i></button>
            </td>
        </tr>
    `).join('');
}
function openClassModal() {
    document.getElementById('classForm').reset();
    currentEditingId = null;
    document.getElementById('classModalTitle').textContent = 'Nouvelle classe';
    openModal('classModal');
}
window.openClassModal = openClassModal;

function saveClass() {
    const data = {
        name: document.getElementById('className').value.trim(),
        level: document.getElementById('classLevel').value.trim(),
        year: document.getElementById('classYear').value.trim(),
    };
    
    if (!data.name) {
        showAlert("Le nom de la classe est obligatoire.", "warning");
        return;
    }

    if (currentEditingId) {
        const index = appState.classes.findIndex(c => c.id === currentEditingId);
        if (index > -1) {
            appState.classes[index] = { ...appState.classes[index], ...data };
        }
    } else {
        data.id = generateId();
        appState.classes.push(data);
    }
    
    saveDataToLocalStorage();
    updateClassesTable();
    updateAllFilters();
    updateDashboard();
    closeModal('classModal');
    showAlert('Classe sauvegardée.', 'success');
}
window.saveClass = saveClass;

function editClass(id) {
    const c = appState.classes.find(cls => cls.id === id);
    if (!c) return;
    currentEditingId = c.id;
    document.getElementById('className').value = c.name;
    document.getElementById('classLevel').value = c.level;
    document.getElementById('classYear').value = c.year;
    document.getElementById('classModalTitle').textContent = 'Modifier la classe';
    openModal('classModal');
}
window.editClass = editClass;

function deleteClass(id) { 
    const studentInClass = appState.students.some(s => s.classId === id);
    if (studentInClass) {
        showAlert("Impossible de supprimer la classe, des élèves y sont encore rattachés.", "warning");
        return;
    }
    deleteItem('classes', id); 
}
window.deleteClass = deleteClass;

// ** STUDENTS **
function updateStudentsTable() {
    const classFilter = document.getElementById('studentClassFilter').value;
    const filteredStudents = (classFilter === 'all' || !classFilter)
        ? appState.students 
        : appState.students.filter(s => s.classId === classFilter);

    const tbody = document.getElementById('studentsTable');
    if(!tbody) return;
    tbody.innerHTML = filteredStudents.map(s => {
        const className = appState.classes.find(c => c.id === s.classId)?.name || 'N/A';
        const studentGroups = appState.groups
            .filter(g => g.members && g.members.includes(s.id))
            .map(g => `<span class="student-groups-badge" title="${g.name}">${g.name.substring(0, 10)}${g.name.length > 10 ? '...' : ''}</span>`)
            .join(' ');
        return `
            <tr>
                <td>${s.lastName}</td>
                <td>${s.firstName}</td>
                <td>${s.genre || ''}</td>
                <td>${className}</td>
                <td>${studentGroups}</td>
                <td>${s.birthDate ? formatDate(s.birthDate) : ''}</td>
                <td class="actions">
                    <button class="btn-icon" onclick="window.editStudent('${s.id}')" title="Modifier"><i class="fas fa-pencil-alt"></i></button>
                    <button class="btn-icon" onclick="window.deleteStudent('${s.id}')" title="Supprimer"><i class="fas fa-trash"></i></button>
                </td>
            </tr>
        `;
    }).join('');
}

function filterStudents() {
    updateStudentsTable();
}
window.filterStudents = filterStudents;

function openStudentModal() {
    document.getElementById('studentForm').reset();
    currentEditingId = null;
    document.getElementById('studentModalTitle').textContent = 'Nouvel élève';
    populateSelectWithOptions('studentClassId', appState.classes, 'Choisir une classe');
    openModal('studentModal');
}
window.openStudentModal = openStudentModal;

function saveStudent() {
     const data = {
        lastName: document.getElementById('studentLastName').value.trim(),
        firstName: document.getElementById('studentFirstName').value.trim(),
        genre: document.getElementById('studentGenre').value,
        birthDate: document.getElementById('studentBirthDate').value,
        classId: document.getElementById('studentClassId').value,
    };
    
    if (!data.lastName || !data.firstName || !data.classId) {
        showAlert("Nom, prénom et classe sont obligatoires.", "warning");
        return;
    }

    if (currentEditingId) {
        const index = appState.students.findIndex(s => s.id === currentEditingId);
        if (index > -1) {
            appState.students[index] = { ...appState.students[index], ...data };
        }
    } else {
        data.id = generateId();
        appState.students.push(data);
    }

    saveDataToLocalStorage();
    updateStudentsTable();
    updateDashboard();
    closeModal('studentModal');
    showAlert('Élève sauvegardé.', 'success');
}
window.saveStudent = saveStudent;

function editStudent(id) {
    const s = appState.students.find(std => std.id === id);
    if (!s) return;
    currentEditingId = s.id;
    document.getElementById('studentLastName').value = s.lastName;
    document.getElementById('studentFirstName').value = s.firstName;
    document.getElementById('studentGenre').value = s.genre || '';
    document.getElementById('studentBirthDate').value = s.birthDate;
    document.getElementById('studentClassId').value = s.classId;
    document.getElementById('studentModalTitle').textContent = 'Modifier l\'élève';
    openModal('studentModal');
}
window.editStudent = editStudent;

function deleteStudent(id) { deleteItem('students', id); }
window.deleteStudent = deleteStudent;

// ** GROUPS **
function updateGroupsTable() {
    const tbody = document.getElementById('groupsTable');
    if (!tbody) return;
    tbody.innerHTML = appState.groups.map(g => {
        const className = appState.classes.find(c => c.id === g.classId)?.name || 'N/A';
        return `
            <tr>
                <td>${g.name}</td>
                <td>${g.type || ''}</td>
                <td>${className}</td>
                <td>${g.members?.length || 0} membres</td>
                <td class="actions">
                    <button class="btn-icon" onclick="window.editGroup('${g.id}')" title="Modifier"><i class="fas fa-pencil-alt"></i></button>
                    <button class="btn-icon" onclick="window.deleteGroup('${g.id}')" title="Supprimer"><i class="fas fa-trash"></i></button>
                </td>
            </tr>
        `;
    }).join('');
}
function openGroupModal() {
    document.getElementById('groupForm').reset();
    currentEditingId = null;
    document.getElementById('groupModalTitle').textContent = 'Nouveau groupe';
    populateSelectWithOptions('groupClassId', appState.classes, "Sélectionner une classe");
    document.getElementById('groupClassId').onchange = () => updateGroupStudentsList([]);
    updateGroupStudentsList([]);
    openModal('groupModal');
}
window.openGroupModal = openGroupModal;

function updateGroupStudentsList(selectedStudentIds = []) {
    const classId = document.getElementById('groupClassId').value;
    const students = classId ? appState.students.filter(s => s.classId === classId) : [];
    const container = document.getElementById('groupStudentsContainer');
    container.innerHTML = students.map(s => `
        <label>
            <input type="checkbox" name="groupMembers" value="${s.id}" ${selectedStudentIds && selectedStudentIds.includes(s.id) ? 'checked' : ''}>
            ${s.firstName} ${s.lastName}
        </label>
    `).join('');
}

function saveGroup() {
    const members = Array.from(document.querySelectorAll('[name="groupMembers"]:checked')).map(el => el.value);
    const data = {
        name: document.getElementById('groupName').value.trim(),
        type: document.getElementById('groupType').value.trim(),
        classId: document.getElementById('groupClassId').value,
        members: members
    };
    
    if (!data.name || !data.classId) {
        showAlert("Nom du groupe et classe sont obligatoires.", "warning");
        return;
    }
    
    if (currentEditingId) {
        const index = appState.groups.findIndex(g => g.id === currentEditingId);
        if (index > -1) {
            appState.groups[index] = { ...appState.groups[index], ...data };
        }
    } else {
        data.id = generateId();
        appState.groups.push(data);
    }
    
    saveDataToLocalStorage();
    updateGroupsTable();
    updateStudentsTable(); // Update student table to show new group affiliation
    updateDashboard();
    closeModal('groupModal');
    showAlert('Groupe sauvegardé.', 'success');
}
window.saveGroup = saveGroup;

function editGroup(id) {
    const g = appState.groups.find(grp => grp.id === id);
    if (!g) return;
    openGroupModal();
    currentEditingId = g.id;
    document.getElementById('groupModalTitle').textContent = 'Modifier le groupe';
    document.getElementById('groupName').value = g.name;
    document.getElementById('groupType').value = g.type;
    document.getElementById('groupClassId').value = g.classId;
    updateGroupStudentsList(g.members);
}
window.editGroup = editGroup;

function deleteGroup(id) { deleteItem('groups', id); }
window.deleteGroup = deleteGroup;

// ** ROOMS & SEATING PLANS **
function updateRoomsTable() {
    const tbody = document.getElementById('roomsTable');
    if (!tbody) return;
    tbody.innerHTML = appState.rooms.map(r => `
        <tr>
            <td>${r.name}</td>
            <td>${r.description || ''}</td>
            <td>${r.rows || 'N/A'} x ${r.cols || 'N/A'}</td>
            <td class="actions">
                <button class="btn-icon" onclick="window.editRoom('${r.id}')" title="Modifier"><i class="fas fa-pencil-alt"></i></button>
                <button class="btn-icon" onclick="window.deleteRoom('${r.id}')" title="Supprimer"><i class="fas fa-trash"></i></button>
            </td>
        </tr>
    `).join('');
}
function openRoomModal() {
    currentEditingId = null;
    document.getElementById('roomForm').reset();
    document.getElementById('roomModalTitle').textContent = 'Nouvelle Salle';
    openModal('roomModal');
}
window.openRoomModal = openRoomModal;

function saveRoom() {
    const data = {
        name: document.getElementById('roomName').value.trim(),
        description: document.getElementById('roomDescription').value.trim(),
        rows: parseInt(document.getElementById('roomRows').value),
        cols: parseInt(document.getElementById('roomCols').value),
    };

    if (!data.name || !data.rows || !data.cols) {
        showAlert("Nom, rangées et colonnes sont obligatoires.", "warning");
        return;
    }

    if (currentEditingId) {
        const index = appState.rooms.findIndex(r => r.id === currentEditingId);
        appState.rooms[index] = { ...appState.rooms[index], ...data };
    } else {
        data.id = generateId();
        appState.rooms.push(data);
    }
    saveDataToLocalStorage();
    updateRoomsTable();
    closeModal('roomModal');
    showAlert('Salle sauvegardée.', 'success');
}
window.saveRoom = saveRoom;

function editRoom(id) {
    const room = appState.rooms.find(r => r.id === id);
    if (!room) return;
    openRoomModal();
    currentEditingId = id;
    document.getElementById('roomModalTitle').textContent = 'Modifier la Salle';
    document.getElementById('roomName').value = room.name;
    document.getElementById('roomDescription').value = room.description;
    document.getElementById('roomRows').value = room.rows;
    document.getElementById('roomCols').value = room.cols;
}
window.editRoom = editRoom;

function deleteRoom(id) { deleteItem('rooms', id); }
window.deleteRoom = deleteRoom;

function updateSeatingChartsTable() {
    const tbody = document.getElementById('seatingChartsTable');
    if (!tbody) return;
    tbody.innerHTML = appState.seating_charts.map(sc => {
        const className = appState.classes.find(c => c.id === sc.classId)?.name || 'N/A';
        const roomName = appState.rooms.find(r => r.id === sc.roomId)?.name || 'N/A';
        return `
            <tr>
                <td>${sc.name}</td>
                <td>${className}</td>
                <td>${roomName}</td>
                <td>${formatDate(sc.createdAt)}</td>
                <td class="actions">
                    <button class="btn-icon" onclick="window.editSeatingChart('${sc.id}')" title="Modifier"><i class="fas fa-pencil-alt"></i></button>
                    <button class="btn-icon" onclick="window.deleteSeatingChart('${sc.id}')" title="Supprimer"><i class="fas fa-trash"></i></button>
                </td>
            </tr>
        `;
    }).join('');
}
function openSeatingChartModal() {
    currentEditingId = null;
    document.getElementById('seatingChartForm').reset();
    document.getElementById('seatingChartModalTitle').textContent = 'Créer un Plan de Classe';
    populateSelectWithOptions('seatingChartClassId', appState.classes, 'Choisir une classe');
    populateSelectWithOptions('seatingChartRoomId', appState.rooms, 'Choisir une salle');
    currentSeatingArrangement = {};
    renderSeatingChartEditor();
    openModal('seatingChartModal');
}
window.openSeatingChartModal = openSeatingChartModal;

function saveSeatingChart() {
    const data = {
        name: document.getElementById('seatingChartName').value,
        classId: document.getElementById('seatingChartClassId').value,
        roomId: document.getElementById('seatingChartRoomId').value,
        arrangement: currentSeatingArrangement,
    };
    if (!data.name || !data.classId || !data.roomId) {
        showAlert("Nom, classe et salle sont obligatoires.", "warning");
        return;
    }
    if (currentEditingId) {
        const index = appState.seating_charts.findIndex(sc => sc.id === currentEditingId);
        appState.seating_charts[index] = { ...appState.seating_charts[index], ...data };
    } else {
        data.id = generateId();
        data.createdAt = new Date().toISOString();
        appState.seating_charts.push(data);
    }
    saveDataToLocalStorage();
    updateSeatingChartsTable();
    closeModal('seatingChartModal');
    showAlert('Plan de classe sauvegardé.', 'success');
}
window.saveSeatingChart = saveSeatingChart;

function editSeatingChart(id) {
    const sc = appState.seating_charts.find(s => s.id === id);
    if (!sc) return;
    openSeatingChartModal();
    currentEditingId = id;
    document.getElementById('seatingChartModalTitle').textContent = 'Modifier le Plan de Classe';
    document.getElementById('seatingChartName').value = sc.name;
    document.getElementById('seatingChartClassId').value = sc.classId;
    document.getElementById('seatingChartRoomId').value = sc.roomId;
    currentSeatingArrangement = sc.arrangement || {};
    renderSeatingChartEditor();
}
window.editSeatingChart = editSeatingChart;

function deleteSeatingChart(id) { deleteItem('seating_charts', id); }
window.deleteSeatingChart = deleteSeatingChart;

function renderSeatingChartEditor() {
    const classId = document.getElementById('seatingChartClassId').value;
    const roomId = document.getElementById('seatingChartRoomId').value;
    const grid = document.getElementById('seatingChartGrid');
    const studentListEl = document.getElementById('seatingChartStudentList');

    grid.innerHTML = '';
    studentListEl.innerHTML = '';
    
    if (!classId || !roomId) {
        grid.innerHTML = '<p class="text-muted text-center">Sélectionnez une classe et une salle.</p>';
        return;
    }
    
    const room = appState.rooms.find(r => r.id === roomId);
    const students = appState.students.filter(s => s.classId === classId);

    if (!room) return;

    grid.style.gridTemplateColumns = `repeat(${room.cols}, 1fr)`;
    grid.style.gridTemplateRows = `repeat(${room.rows}, 1fr)`;

    for (let r = 0; r < room.rows; r++) {
        for (let c = 0; c < room.cols; c++) {
            const deskId = `${r}-${c}`;
            const studentId = currentSeatingArrangement[deskId];
            const student = studentId ? students.find(s => s.id === studentId) : null;
            const desk = document.createElement('div');
            desk.className = 'desk-cell';
            desk.dataset.deskId = deskId;
            if (student) {
                desk.classList.add('assigned');
                desk.textContent = `${student.firstName} ${student.lastName.charAt(0)}.`;
            }
            desk.onclick = () => selectDeskForAssignment(deskId);
            grid.appendChild(desk);
        }
    }

    studentListEl.innerHTML = students.map(s => {
        const isAssigned = Object.values(currentSeatingArrangement).includes(s.id);
        return `<div class="student-item ${isAssigned ? 'assigned-elsewhere' : ''}" data-student-id="${s.id}" onclick="assignStudentToSelectedDesk('${s.id}')">
            ${s.firstName} ${s.lastName}
        </div>`;
    }).join('');
}
window.renderSeatingChartEditor = renderSeatingChartEditor;

function selectDeskForAssignment(deskId) {
    // If a desk is already selected, try to assign student or just deselect
    if(selectedDeskForAssignment) {
        document.querySelector(`[data-desk-id="${selectedDeskForAssignment}"]`)?.classList.remove('selected-for-assignment');
    }

    // If the clicked desk is already selected, deselect it
    if(selectedDeskForAssignment === deskId) {
        selectedDeskForAssignment = null;
        return;
    }
    
    selectedDeskForAssignment = deskId;
    document.querySelector(`[data-desk-id="${deskId}"]`)?.classList.add('selected-for-assignment');

    // If a student is already in the desk, un-assign them
    const studentIdInDesk = currentSeatingArrangement[deskId];
    if (studentIdInDesk) {
        delete currentSeatingArrangement[deskId];
        renderSeatingChartEditor();
        selectedDeskForAssignment = deskId; // Re-select the desk
        document.querySelector(`[data-desk-id="${deskId}"]`)?.classList.add('selected-for-assignment');
    }
}
window.selectDeskForAssignment = selectDeskForAssignment;

function assignStudentToSelectedDesk(studentId) {
    if (!selectedDeskForAssignment) {
        showAlert("Veuillez d'abord sélectionner une place.", 'info');
        return;
    }

    // Check if student is already assigned somewhere else and unassign them
    for (const desk in currentSeatingArrangement) {
        if (currentSeatingArrangement[desk] === studentId) {
            delete currentSeatingArrangement[desk];
        }
    }

    currentSeatingArrangement[selectedDeskForAssignment] = studentId;
    
    // Deselect desk after assignment
    document.querySelector(`[data-desk-id="${selectedDeskForAssignment}"]`)?.classList.remove('selected-for-assignment');
    selectedDeskForAssignment = null;
    
    renderSeatingChartEditor();
}
window.assignStudentToSelectedDesk = assignStudentToSelectedDesk;

// ** REPORTS **
function generateReport() {
    showAlert("La génération de rapports est en cours de développement.", "info");
}
window.generateReport = generateReport;

// ** SETTINGS - TIMETABLE **
function updateTimetableSlotsTable() {
    const tbody = document.getElementById('timetableSlotsTable');
    if(!tbody) return;
    tbody.innerHTML = appState.timetable_slots.sort((a,b) => a.start.localeCompare(b.start)).map(ts => `
        <tr>
            <td>${ts.day}</td>
            <td>${ts.start}</td>
            <td>${ts.end}</td>
            <td>${ts.label || ''}</td>
            <td class="actions">
                <button class="btn-icon" onclick="window.editTimeSlot('${ts.id}')" title="Modifier"><i class="fas fa-pencil-alt"></i></button>
                <button class="btn-icon" onclick="window.deleteTimeSlot('${ts.id}')" title="Supprimer"><i class="fas fa-trash"></i></button>
            </td>
        </tr>
    `).join('');
}
function openTimeSlotModal() {
    currentEditingId = null;
    document.getElementById('timeSlotForm').reset();
    document.getElementById('timeSlotModalTitle').textContent = 'Ajouter un créneau';
    openModal('timeSlotModal');
}
window.openTimeSlotModal = openTimeSlotModal;

function saveTimeSlot() {
    const data = {
        day: document.getElementById('timeSlotDay').value,
        start: document.getElementById('timeSlotStart').value,
        end: document.getElementById('timeSlotEnd').value,
        label: document.getElementById('timeSlotLabel').value.trim(),
    };
    if (currentEditingId) {
        const index = appState.timetable_slots.findIndex(ts => ts.id === currentEditingId);
        appState.timetable_slots[index] = { ...appState.timetable_slots[index], ...data };
    } else {
        data.id = generateId();
        appState.timetable_slots.push(data);
    }
    saveDataToLocalStorage();
    updateTimetableSlotsTable();
    updateTimetableDisplay();
    closeModal('timeSlotModal');
    showAlert('Créneau sauvegardé.', 'success');
}
window.saveTimeSlot = saveTimeSlot;

function editTimeSlot(id) {
    const slot = appState.timetable_slots.find(s => s.id === id);
    if (!slot) return;
    openTimeSlotModal();
    currentEditingId = id;
    document.getElementById('timeSlotModalTitle').textContent = 'Modifier le créneau';
    document.getElementById('timeSlotDay').value = slot.day;
    document.getElementById('timeSlotStart').value = slot.start;
    document.getElementById('timeSlotEnd').value = slot.end;
    document.getElementById('timeSlotLabel').value = slot.label;
}
window.editTimeSlot = editTimeSlot;

function deleteTimeSlot(id) { 
    deleteItem('timetable_slots', id); 
    updateTimetableDisplay();
}
window.deleteTimeSlot = deleteTimeSlot;

// ** SETTINGS - SKILLS **
function populateSubjectFilterForSkills() {
    const select = document.getElementById('skillSubjectFilter');
    if (!select) return;
    select.innerHTML = '<option value="all">Toutes les matières</option>';
    appState.subjects.forEach(s => select.innerHTML += `<option value="${s}">${s}</option>`);
}
function updateSkillsTable() {
    const tbody = document.getElementById('skillsTable');
    if (!tbody) return;
    tbody.innerHTML = appState.skills.map(s => `
        <tr>
            <td>${s.name}</td>
            <td>${s.description || ''}</td>
            <td>${s.subjects?.join(', ') || ''}</td>
            <td class="actions">
                <button class="btn-icon" onclick="window.editSkill('${s.id}')" title="Modifier"><i class="fas fa-pencil-alt"></i></button>
                <button class="btn-icon" onclick="window.deleteSkill('${s.id}')" title="Supprimer"><i class="fas fa-trash"></i></button>
            </td>
        </tr>
    `).join('');
}
function openSkillModal() {
    currentEditingId = null;
    document.getElementById('skillForm').reset();
    document.getElementById('skillModalTitle').textContent = 'Ajouter une compétence';
    const subjectSelect = document.getElementById('skillSubjects');
    subjectSelect.innerHTML = '';
    appState.subjects.forEach(s => subjectSelect.innerHTML += `<option value="${s}">${s}</option>`);
    openModal('skillModal');
}
window.openSkillModal = openSkillModal;

function saveSkill() {
    const subjects = Array.from(document.getElementById('skillSubjects').selectedOptions).map(o => o.value);
    const data = {
        name: document.getElementById('skillName').value.trim(),
        description: document.getElementById('skillDescription').value.trim(),
        subjects: subjects,
    };
    if (currentEditingId) {
        const index = appState.skills.findIndex(s => s.id === currentEditingId);
        appState.skills[index] = { ...appState.skills[index], ...data };
    } else {
        data.id = generateId();
        appState.skills.push(data);
    }
    saveDataToLocalStorage();
    updateSkillsTable();
    closeModal('skillModal');
    showAlert('Compétence sauvegardée.', 'success');
}
window.saveSkill = saveSkill;

function editSkill(id) {
    const skill = appState.skills.find(s => s.id === id);
    if (!skill) return;
    openSkillModal();
    currentEditingId = id;
    document.getElementById('skillModalTitle').textContent = 'Modifier la compétence';
    document.getElementById('skillName').value = skill.name;
    document.getElementById('skillDescription').value = skill.description;
    Array.from(document.getElementById('skillSubjects').options).forEach(opt => {
        opt.selected = skill.subjects?.includes(opt.value) ?? false;
    });
}
window.editSkill = editSkill;

function deleteSkill(id) { deleteItem('skills', id); }
window.deleteSkill = deleteSkill;

// ** SETTINGS - ACQUISITION LEVELS **
function updateAcquisitionLevelsTable() {
    const tbody = document.getElementById('acquisitionLevelsTable');
    if (!tbody) return;
    tbody.innerHTML = appState.acquisition_levels.sort((a,b) => a.order - b.order).map(l => `
        <tr>
            <td>${l.order}</td>
            <td>${l.code}</td>
            <td>${l.label}</td>
            <td>${l.successRate !== undefined ? `${l.successRate}%` : ''}</td>
            <td>${l.gradeEquivalent || ''}</td>
            <td><div class="level-color-preview" style="background-color:${l.colorBg};"></div></td>
            <td class="actions">
                <button class="btn-icon" onclick="window.editAcquisitionLevel('${l.id}')" title="Modifier"><i class="fas fa-pencil-alt"></i></button>
                <button class="btn-icon" onclick="window.deleteAcquisitionLevel('${l.id}')" title="Supprimer"><i class="fas fa-trash"></i></button>
            </td>
        </tr>
    `).join('');
}
function openAcquisitionLevelModal() {
    currentEditingId = null;
    document.getElementById('acquisitionLevelForm').reset();
    document.getElementById('acquisitionLevelModalTitle').textContent = 'Ajouter un niveau';
    openModal('acquisitionLevelModal');
}
window.openAcquisitionLevelModal = openAcquisitionLevelModal;

function saveAcquisitionLevel() {
    const data = {
        order: parseInt(document.getElementById('acqLevelOrder').value),
        code: document.getElementById('acqLevelCode').value,
        label: document.getElementById('acqLevelLabel').value,
        successRate: parseInt(document.getElementById('acqLevelSuccessRate').value),
        gradeEquivalent: document.getElementById('acqLevelGradeEquivalent').value,
        colorBg: document.getElementById('acqLevelColorBg').value,
        colorText: document.getElementById('acqLevelColorText').value,
    };
    if (currentEditingId) {
        const index = appState.acquisition_levels.findIndex(l => l.id === currentEditingId);
        appState.acquisition_levels[index] = { ...appState.acquisition_levels[index], ...data };
    } else {
        data.id = generateId();
        appState.acquisition_levels.push(data);
    }
    saveDataToLocalStorage();
    updateAcquisitionLevelsTable();
    closeModal('acquisitionLevelModal');
    showAlert("Niveau d'acquisition sauvegardé.", 'success');
}
window.saveAcquisitionLevel = saveAcquisitionLevel;

function editAcquisitionLevel(id) {
    const level = appState.acquisition_levels.find(l => l.id === id);
    if (!level) return;
    openAcquisitionLevelModal();
    currentEditingId = id;
    document.getElementById('acquisitionLevelModalTitle').textContent = 'Modifier le niveau';
    document.getElementById('acqLevelOrder').value = level.order;
    document.getElementById('acqLevelCode').value = level.code;
    document.getElementById('acqLevelLabel').value = level.label;
    document.getElementById('acqLevelSuccessRate').value = level.successRate;
    document.getElementById('acqLevelGradeEquivalent').value = level.gradeEquivalent;
    document.getElementById('acqLevelColorBg').value = level.colorBg;
    document.getElementById('acqLevelColorText').value = level.colorText;
}
window.editAcquisitionLevel = editAcquisitionLevel;

function deleteAcquisitionLevel(id) { deleteItem('acquisition_levels', id); }
window.deleteAcquisitionLevel = deleteAcquisitionLevel;

// ** SETTINGS - SUBJECTS & PERIODS **
function updateSubjectsTable() {
    const tbody = document.getElementById('subjectsTable');
    if(!tbody) return;
    tbody.innerHTML = appState.subjects.map((s,i)=>`<tr><td>${s}</td><td class="text-right"><button class="btn-icon" onclick="window.editSubject(${i})"><i class="fas fa-pencil-alt"></i></button><button class="btn-icon" onclick="window.deleteSubject(${i})"><i class="fas fa-trash"></i></button></td></tr>`).join('');
}
function openSubjectModal() {
    document.getElementById('subjectForm').reset();
    document.getElementById('subjectIndex').value='';
    document.getElementById('subjectModalTitle').textContent='Ajouter une matière';
    openModal('subjectModal');
}
function saveSubject() {
    const idx = document.getElementById('subjectIndex').value;
    const name = document.getElementById('subjectName').value.trim();
    if(!name){ showAlert('Nom obligatoire','warning'); return; }
    if(idx!==''){ appState.subjects[parseInt(idx)] = name; } else { appState.subjects.push(name); }
    saveDataToLocalStorage();
    updateSubjectsTable();
    populateSubjectFilterForSkills();
    updateEvaluationFilters();
    closeModal('subjectModal');
    showAlert('Matière sauvegardée','success');
}
function editSubject(i) {
    document.getElementById('subjectForm').reset();
    document.getElementById('subjectIndex').value=i;
    document.getElementById('subjectName').value=appState.subjects[i];
    document.getElementById('subjectModalTitle').textContent='Modifier la matière';
    openModal('subjectModal');
}
function deleteSubject(i) {
    showConfirmationModal('Supprimer cette matière ?',()=>{
        appState.subjects.splice(i,1);
        saveDataToLocalStorage();
        updateSubjectsTable();
        populateSubjectFilterForSkills();
        updateEvaluationFilters();
        showAlert('Matière supprimée','success');
    });
}

function updatePeriodsTable() {
    const tbody = document.getElementById('periodsTable');
    if(!tbody) return;
    tbody.innerHTML = appState.periods.map((p,i)=>`<tr><td>${p}</td><td class="text-right"><button class="btn-icon" onclick="window.editPeriod(${i})"><i class="fas fa-pencil-alt"></i></button><button class="btn-icon" onclick="window.deletePeriod(${i})"><i class="fas fa-trash"></i></button></td></tr>`).join('');
}
function openPeriodModal() {
    document.getElementById('periodForm').reset();
    document.getElementById('periodIndex').value='';
    document.getElementById('periodModalTitle').textContent='Ajouter une période';
    openModal('periodModal');
}
function savePeriod() {
    const idx = document.getElementById('periodIndex').value;
    const name = document.getElementById('periodName').value.trim();
    if(!name){ showAlert('Nom obligatoire','warning'); return; }
    if(idx!==''){ appState.periods[parseInt(idx)] = name; } else { appState.periods.push(name); }
    saveDataToLocalStorage();
    updatePeriodsTable();
    updateEvaluationFilters();
    closeModal('periodModal');
    showAlert('Période sauvegardée','success');
}
function editPeriod(i) {
    document.getElementById('periodForm').reset();
    document.getElementById('periodIndex').value=i;
    document.getElementById('periodName').value=appState.periods[i];
    document.getElementById('periodModalTitle').textContent='Modifier la période';
    openModal('periodModal');
}
function deletePeriod(i) {
    showConfirmationModal('Supprimer cette période ?',()=>{
        appState.periods.splice(i,1);
        saveDataToLocalStorage();
        updatePeriodsTable();
        updateEvaluationFilters();
        showAlert('Période supprimée','success');
    });
}

// --- iCAL Functions ---
function saveIcalUrl() {
    const url = document.getElementById('icalUrlInput').value.trim();
    appState.icalUrl = url;
    saveDataToLocalStorage();
    showAlert('URL iCal sauvegardée.', 'success');
    loadIcalData(); // Fetch new data immediately
}
window.saveIcalUrl = saveIcalUrl;

function loadIcalUrl() {
    document.getElementById('icalUrlInput').value = appState.icalUrl || '';
    if (appState.icalUrl) {
        loadIcalData();
    }
}

async function loadIcalData() {
    if (!appState.icalUrl) {
        icalEvents = [];
        updateTimetableDisplay();
        return;
    }

    try {
        // Using a more reliable CORS proxy
        const proxyUrl = 'https://api.allorigins.win/raw?url=';
        const response = await fetch(`${proxyUrl}${encodeURIComponent(appState.icalUrl)}`);
        if (!response.ok) {
            throw new Error(`Erreur réseau: ${response.statusText}`);
        }
        const icsData = await response.text();
        parseIcsData(icsData);
    } catch (error) {
        console.error("Erreur lors de la récupération des données iCal:", error);
        showAlert("Impossible de charger le calendrier iCal. Vérifiez l'URL et votre connexion.", "danger");
        icalEvents = [];
    } finally {
        updateTimetableDisplay();
    }
}

function parseIcsData(icsData) {
    try {
        const jcalData = ICAL.parse(icsData);
        const vcalendar = new ICAL.Component(jcalData);
        const vevents = vcalendar.getAllSubcomponents('vevent');
        
        icalEvents = vevents.map(vevent => {
            const event = new ICAL.Event(vevent);
            
            const startDate = event.startDate.toJSDate();
            const endDate = event.endDate.toJSDate();

            // Pronote-specific parsing from description
            const desc = event.description || '';
            const descLines = desc.split('\n');
            const classInfoLine = descLines.find(l => l.startsWith('Classe :') || l.startsWith('Groupe :') || l.startsWith('Partie de classe :'));
            let classInfo = classInfoLine ? classInfoLine.split(':')[1].trim() : '';

            // Clean up summary
            let summary = event.summary;
            if(summary.includes(' : ')){
                summary = summary.split(' : ')[1];
            }
             if(summary.includes(' - ')){
                summary = summary.split(' - ')[0];
            }

            return {
                date: dateToYMD(startDate),
                start: `${String(startDate.getHours()).padStart(2, '0')}:${String(startDate.getMinutes()).padStart(2, '0')}`,
                end: `${String(endDate.getHours()).padStart(2, '0')}:${String(endDate.getMinutes()).padStart(2, '0')}`,
                subject: summary,
                description: event.description,
                location: event.location,
                class: classInfo,
                isCancelled: (event.summary && event.summary.toLowerCase().includes('annulé')) || (event.description && event.description.toLowerCase().includes('annulé')),
                isIcalEvent: true
            };
        });
        showAlert(`${icalEvents.length} événements iCal chargés.`, 'success');
    } catch (e) {
        console.error("Erreur de parsing iCal:", e);
        showAlert("Le fichier iCal est invalide ou dans un format non supporté.", "danger");
        icalEvents = [];
    }
}

function updateTimetableDisplay() {
    const container = document.getElementById('timetableDisplayContainer');
    const weekLabel = document.getElementById('currentWeekLabel');
    if (!container || !weekLabel) return;

    // 1. Calculate week dates
    const today = new Date();
    today.setDate(today.getDate() + weekOffset * 7);
    const dayOfWeek = today.getDay(); // 0=Sun, 1=Mon, ..., 6=Sat
    const diff = today.getDate() - dayOfWeek + (dayOfWeek === 0 ? -6 : 1); // adjust when day is sunday
    const monday = new Date(today.setDate(diff));

    const weekDates = [];
    const weekDays = ['Lundi', 'Mardi', 'Mercredi', 'Jeudi', 'Vendredi', 'Samedi', 'Dimanche']; // French days
    for (let i = 0; i < 7; i++) {
        const d = new Date(monday);
        d.setDate(monday.getDate() + i);
        weekDates.push(d);
    }

    const startOfWeek = weekDates[0];
    const endOfWeek = weekDates[6];
    weekLabel.textContent = `Du ${startOfWeek.toLocaleDateString('fr-FR', {day:'numeric', month:'short'})} au ${endOfWeek.toLocaleDateString('fr-FR', {day:'numeric', month:'short', year:'numeric'})}`;

    // 2. Get lessons for the week
    const weekDateStrings = weekDates.map(d => dateToYMD(d));
    const allLessonsThisWeek = [
        ...appState.timetable_lessons.filter(l => weekDateStrings.includes(l.date)),
        ...icalEvents.filter(e => weekDateStrings.includes(e.date))
    ].sort((a,b) => a.start.localeCompare(b.start));

    // 3. Build HTML
    let html = `<div class="timetable-grid">`;

    weekDays.forEach((day, i) => {
        const date = weekDates[i];
        const dateStr = dateToYMD(date);
        const lessonsForDay = allLessonsThisWeek.filter(l => l.date === dateStr);

        html += `<div class="timetable-day">
            <div class="timetable-header">${day} <span class="date">${date.getDate()}</span></div>
            <div class="timetable-lessons">`;
        
        if (lessonsForDay.length > 0) {
            lessonsForDay.forEach(lesson => {
                const isIcal = lesson.isIcalEvent;
                const className = isIcal ? lesson.class : (appState.classes.find(c => c.id === lesson.classId)?.name || '');
                const colorSource = lesson.subject ? lesson.subject + (className || '') : 'default';
                const color = generateColorFromString(colorSource);
                const isCancelled = isIcal && lesson.isCancelled;

                html += `
                    <div class="lesson-chip ${isIcal ? 'ical-event' : ''} ${isCancelled ? 'cancelled-event' : ''}" style="background-color: ${color};">
                        <strong>${lesson.subject}</strong>
                        <small>${lesson.start} - ${lesson.end}</small>
                        <small>${className} ${lesson.location || lesson.room ? `| ${lesson.location || lesson.room}`: ''}</small>
                    </div>`;
            });
        } else {
            // html += `<div class="no-lessons-placeholder"></div>`;
        }

        html += `</div></div>`;
    });

    html += `</div>`;
    container.innerHTML = html;
}

function generateColorFromString(str) {
    let hash = 0;
    for (let i = 0; i < str.length; i++) {
        hash = str.charCodeAt(i) + ((hash << 5) - hash);
    }
    let color = '#';
    for (let i = 0; i < 3; i++) {
        let value = (hash >> (i * 8)) & 0xFF;
        // Make colors less saturated and brighter for better readability
        value = Math.floor((value + 255) / 2); // Brighter
        value = Math.min(value, 200); // Avoid very light colors
        color += ('00' + value.toString(16)).substr(-2);
    }
    return color;
}

// --- INITIALIZATION ---
document.addEventListener('DOMContentLoaded', async () => {
    loadTheme();
    await loadDataFromJsonFile();
    initializeAppData();
    document.getElementById('evaluationFilters').querySelectorAll('select').forEach(sel => {
       sel.addEventListener('change', loadGradeTable);
    });
    updateTimetableDisplay();
    document.getElementById('prevWeekBtn')?.addEventListener('click', ()=>{ weekOffset--; updateTimetableDisplay(); });
    document.getElementById('nextWeekBtn')?.addEventListener('click', ()=>{ weekOffset++; updateTimetableDisplay(); });
    initJsonHelpTabs();
});

function initJsonHelpTabs(){
  const tabs = [
    {id:'base',label:'Base complète', ex: JSON.stringify({"classes":[{"id":"class-1","name":"6ème A","level":"6ème","year":"2024-2025"}],"students":[{"id":"uuid-student-1","lastName":"Dupont","firstName":"Jean","genre":"G","birthDate":"2010-05-12","classId":"class-1"}],"groups":[{"id":"grp-1","name":"Soutien","type":"Aide","classId":"class-1","members":["uuid-student-1"]}],"evaluations":[{"id":"ev1","name":"Contrôle 1","date":"2025-09-01","targetType":"class","targetId":"class-1","period":"Trimestre 1","subject":"Mathématiques","type":"grade","maxPoints":20,"coefficient":1,"isBonus":false,"skillIds":[]}],"student_grades":[{"id":"g1","studentId":"uuid-student-1","evaluationId":"ev1","value":"14","comment":"Bien","skillLevels":{}}],"absences":[{"id":"abs1","studentId":"uuid-student-1","date":"2025-09-02","type":"absence","reason":"malade","justified":true}],"timetable_slots":[{"id":"t1","day":"Lundi","start":"08:00","end":"08:55","label":"M1"}],"skills":[{"id":"sk1","name":"Calculer","description":"Opérations de base","subjects":["Mathématiques"]}],"acquisition_levels":[{"id":"lvl1","order":1,"code":"++","label":"Très bonne maîtrise","successRate":100,"gradeEquivalent":"16-20","colorBg":"#dcfce7","colorText":"#14532d"}],"rooms":[{"id":"room1","name":"Salle 101","description":"Salle de classe standard","rows":5,"cols":6}],"seating_charts":[{"id":"sc1","name":"Plan de début d'année","classId":"class-1","roomId":"room1","arrangement":{"0-0":"uuid-student-1"},"createdAt":"2024-09-01T10:00:00.000Z"}],"timetable_lessons":[{"date":"2025-09-01","start":"08:00","end":"08:50","subject":"Mathématiques","classId":"class-1","room":"101","teacher":"Mme Martin"}],"subjects":["Français","Mathématiques","Histoire"],"periods":["Trimestre 1","Trimestre 2","Trimestre 3"]})},
    {id:'eleves',label:'Élèves',ex:`[{"id":"uuid","lastName":"Dupont","firstName":"Jean","genre":"G","birthDate":"2010-05-12","classId":"class-1"}]`},
    {id:'classes',label:'Classes',ex:`[{"id":"class-1","name":"6ème A","level":"6ème","year":"2024-2025"}]`},
    {id:'groupes',label:'Groupes',ex:`[{"id":"grp-1","name":"Soutien","type":"Aide","classId":"class-1","members":["uuid"]}]`},
    {id:'matieres',label:'Matières',ex:`["Français","Mathématiques","Histoire"]`},
    {id:'periodes',label:'Périodes',ex:`["Trimestre 1","Trimestre 2","Trimestre 3"]`},
    {id:'competences',label:'Compétences',ex:`[{"id":"sk1","name":"Calculer","description":"Opérations de base","subjects":["Mathématiques"]}]`},
    {id:'niveaux',label:"Niveaux d'acq.",ex:`[{"id":"lvl1","order":1,"code":"++","label":"Très bonne maîtrise","successRate":100,"gradeEquivalent":"16-20","colorBg":"#dcfce7","colorText":"#14532d"}]`},
    {id:'creneaux',label:'Grille horaire',ex:`[{"id":"t1","day":"Lundi","start":"08:00","end":"08:55","label":"M1"}]`},
    {id:'evaluations',label:'Évaluations',ex:`[{"id":"ev1","name":"Contrôle 1","date":"2025-09-01","targetType":"class","targetId":"class-1","period":"Trimestre 1","subject":"Mathématiques","type":"grade","maxPoints":20,"coefficient":1,"isBonus":false,"skillIds":[]}]`},
    {id:'notes',label:'Résultats',ex:`[{"id":"g1","studentId":"uuid-student-1","evaluationId":"ev1","value":"14","comment":"Bien","skillLevels":{}}]`},
    {id:'salles',label:'Salles',ex:`[{"id":"room1","name":"Salle 101","description":"Salle standard","rows":5,"cols":6}]`},
    {id:'plans',label:'Plans de classe',ex:`[{"id":"sc1","name":"Plan rentrée","classId":"class-1","roomId":"room1","arrangement":{"0-0":"uuid-student-1"},"createdAt":"2024-09-01T10:00:00.000Z"}]`},
    {id:'edt',label:'EDT (leçons)',ex:`[{"date":"2025-09-01","start":"08:00","end":"08:55","subject":"Mathématiques","classId":"class-1","room":"101","teacher":"Mme Martin"}]`}
  ];
  const tabC = document.getElementById('jsonHelpTabs'); const content = document.getElementById('jsonHelpContent'); if(!tabC||!content) return;
  tabC.innerHTML = tabs.map((t,i)=>`<button class="btn ${i===0?'btn-primary':'btn-secondary'}" data-tab="${t.id}" onclick="window.switchJsonHelpTab('${t.id}')" ${i===0?'style="background-color: #007bff; color: white;"':''}>${t.label}</button>`).join(' ');
  window.__jsonHelpTabs = Object.fromEntries(tabs.map(t=>[t.id,t.ex]));
  window.switchJsonHelpTab = (id)=>{ Array.from(tabC.querySelectorAll('button')).forEach(b=>{b.classList.toggle('btn-primary', b.dataset.tab===id); b.classList.toggle('btn-secondary', b.dataset.tab!==id);}); content.innerHTML = `<pre style="margin:0; font-size:.85rem;">${JSON.stringify(JSON.parse(window.__jsonHelpTabs[id]), null, 2)}</pre>`; };
  window.switchJsonHelpTab(tabs[0].id);
}

function openJsonTemplate(type){
  const templates = {
    fullData: JSON.stringify(appState, null, 2),
    timetableLessons: JSON.stringify([{date:"2025-09-01",start:"08:00",end:"08:55",subject:"Mathématiques",classId:"class-1",room:"101",teacher:"Mme Martin"}], null, 2)
  };
  document.getElementById('jsonHelpModalTitle').textContent = type==='fullData'?'Aide JSON - Données complètes':'Aide JSON - Emploi du temps';
  document.getElementById('jsonHelpModalContent').textContent = templates[type] || '{}';
  openModal('jsonHelpModal');
}
window.openJsonTemplate = openJsonTemplate;

// Ensure inline handlers always find a function
window.saveQuickGrade = window.saveQuickGrade || function () { console.warn('saveQuickGrade non initialisée'); };

// Add: global filters refresh (safe on missing DOM)
function updateAllFilters(){
  const classes=appState.classes.map(c=>({id:c.id,name:c.name}));
  const add=(id,opts,all)=>{const el=document.getElementById(id); if(!el) return; el.innerHTML=(all?'<option value="all">Toutes les classes</option>':'<option value="">Choisir...</option>')+(opts||[]).map(o=>`<option value="${o.id}">${o.name}</option>`).join('');};
  add('studentClassFilter',classes,true); add('absenceClassFilter',classes,true);
  if(document.getElementById('gradeTargetTypeFilter')) updateEvaluationFilters();
  if(document.getElementById('reportClassFilter')) populateSelectWithOptions('reportClassFilter',appState.classes,'Choisir une classe');
  if(document.getElementById('reportPeriodFilter')) populateSelectWithOptions('reportPeriodFilter',appState.periods.map(p=>({id:p,name:p})),'Choisir une période');
}
window.updateAllFilters = updateAllFilters;
