'use strict';

// ─── Audio Engine ───────────────────────────────────────────────────────────
let audioCtx = null;

function getAudioCtx() {
    if (!audioCtx) {
        audioCtx = new (window.AudioContext || window.webkitAudioContext)();
        // Simple master gain — sin compresor, que agrega distorsión propia a ratio alto
        var master = audioCtx.createGain();
        master.gain.value = 0.3;
        master.connect(audioCtx.destination);
        audioCtx._master = master;
    }
    if (audioCtx.state === 'suspended') {
        audioCtx.resume();
    }
    return audioCtx;
}

// Synthesizes a Tibetan singing bowl bell using harmonic oscillators
function playBell(ctx, startTime, volume) {
    volume = volume !== undefined ? volume : 0.6;
    // Frecuencias de bol tibetano agudo — evita graves que vibran en parlantes de celular
    // Ratios inarmónicos típicos: 1× / 2.75× / 5.0×
    // Parciales normalizados (suma = 1.0) para que env.gain == pico real de señal
    var partials = [
        { freq: 432,   vol: 0.68 },
        { freq: 1188,  vol: 0.24 },
        { freq: 2160,  vol: 0.08 }
    ];
    var decayTime = 5.0;

    // Un solo nodo de envolvente para todas las parciales
    var env = ctx.createGain();
    env.gain.setValueAtTime(0, startTime);
    env.gain.linearRampToValueAtTime(volume, startTime + 0.06);
    env.gain.exponentialRampToValueAtTime(0.0001, startTime + decayTime);
    env.connect(ctx._master);

    partials.forEach(function(p) {
        var osc = ctx.createOscillator();
        var gain = ctx.createGain();
        osc.type = 'sine';
        osc.frequency.value = p.freq;
        gain.gain.value = p.vol;
        osc.connect(gain);
        gain.connect(env);
        osc.start(startTime);
        osc.stop(startTime + decayTime + 0.1);
    });
}

function playStartBells() {
    var ctx = getAudioCtx();
    var now = ctx.currentTime;
    [0, 1.6, 3.2].forEach(function(t) {
        playBell(ctx, now + t, 0.38);
    });
}

function playEndBells() {
    var ctx = getAudioCtx();
    var now = ctx.currentTime;
    [0, 2.8, 6.0].forEach(function(t, i) {
        playBell(ctx, now + t, 0.32 - i * 0.05);
    });
}

// ─── Wake Lock ───────────────────────────────────────────────────────────────
var wakeLock = null;

async function acquireWakeLock() {
    if (!('wakeLock' in navigator)) return;
    try {
        wakeLock = await navigator.wakeLock.request('screen');
        updateWakeLockIndicator(true);
        wakeLock.addEventListener('release', function() {
            updateWakeLockIndicator(false);
        });
    } catch (_) {
        updateWakeLockIndicator(false);
    }
}

function releaseWakeLock() {
    if (wakeLock) {
        wakeLock.release();
        wakeLock = null;
    }
    updateWakeLockIndicator(false);
}

function updateWakeLockIndicator(on) {
    var el = document.getElementById('wakeLockIndicator');
    if (el) el.classList.toggle('on', on);
}

document.addEventListener('visibilitychange', function() {
    if (document.visibilityState === 'visible' && state.running) {
        acquireWakeLock();
    }
});

// ─── Timer State ─────────────────────────────────────────────────────────────
var CIRCUMFERENCE = 2 * Math.PI * 90; // r=90 on 200-unit viewBox

var state = {
    durationMs: 10 * 60 * 1000,
    endTime: null,
    remainingOnPause: null,
    running: false,
    finished: false,
    rafId: null
};

// ─── UI refs ─────────────────────────────────────────────────────────────────
var timerDisplay   = document.getElementById('timerDisplay');
var timerLabel     = document.getElementById('timerLabel');
var timerRing      = document.getElementById('timerRing');
var ringProgress   = document.getElementById('ringProgress');
var btnStart       = document.getElementById('btnStart');
var btnReset       = document.getElementById('btnReset');
var statusMsg      = document.getElementById('statusMsg');
var finishedGlow   = document.getElementById('finishedGlow');
var customInput    = document.getElementById('customInput');
var customRow      = document.getElementById('customRow');

// ─── Ring setup ───────────────────────────────────────────────────────────────
ringProgress.style.strokeDasharray = CIRCUMFERENCE;
ringProgress.style.strokeDashoffset = 0;

// ─── Presets ─────────────────────────────────────────────────────────────────
var activePreset = null;

document.querySelectorAll('.preset-btn').forEach(function(btn) {
    btn.addEventListener('click', function() {
        if (state.running) return;
        var mins = parseInt(btn.dataset.mins, 10);
        setPreset(btn, mins);
    });
});

function setPreset(btn, mins) {
    if (state.running) return;
    document.querySelectorAll('.preset-btn').forEach(function(b) { b.classList.remove('active'); });
    customRow.classList.remove('active');
    if (btn) {
        btn.classList.add('active');
        activePreset = btn;
    }
    state.durationMs = mins * 60 * 1000;
    state.remainingOnPause = null;
    resetDisplay();
}

// Custom input
customInput.addEventListener('input', function() {
    if (state.running) return;
    var val = parseInt(customInput.value, 10);
    if (!val || val < 1) return;
    document.querySelectorAll('.preset-btn').forEach(function(b) { b.classList.remove('active'); });
    customRow.classList.add('active');
    activePreset = null;
    state.durationMs = Math.max(1, Math.min(val, 180)) * 60 * 1000;
    state.remainingOnPause = null;
    resetDisplay();
});

customInput.addEventListener('focus', function() {
    if (!state.running) customRow.classList.add('active');
});

document.getElementById('stepUp').addEventListener('click', function() {
    var val = parseInt(customInput.value, 10) || 0;
    customInput.value = Math.min(val + 1, 180);
    customInput.dispatchEvent(new Event('input'));
});

document.getElementById('stepDown').addEventListener('click', function() {
    var val = parseInt(customInput.value, 10) || 2;
    customInput.value = Math.max(val - 1, 1);
    customInput.dispatchEvent(new Event('input'));
});

// ─── Display helpers ──────────────────────────────────────────────────────────
function formatTime(ms) {
    var total = Math.max(0, Math.ceil(ms / 1000));
    var m = Math.floor(total / 60);
    var s = total % 60;
    return String(m).padStart(2, '0') + ':' + String(s).padStart(2, '0');
}

function updateRing(remainingMs) {
    var ratio = remainingMs / state.durationMs;
    ratio = Math.max(0, Math.min(1, ratio));
    var offset = CIRCUMFERENCE * (1 - ratio);
    ringProgress.style.strokeDashoffset = offset;
}

function resetDisplay() {
    var ms = state.remainingOnPause !== null ? state.remainingOnPause : state.durationMs;
    timerDisplay.textContent = formatTime(ms);
    updateRing(ms);
    ringProgress.classList.remove('finished');
    timerLabel.textContent = '';
    statusMsg.textContent = '';
    statusMsg.classList.remove('active');
    finishedGlow.classList.remove('show');
    timerRing.classList.remove('running');
}

// ─── Timer loop ───────────────────────────────────────────────────────────────
function tick() {
    if (!state.running) return;
    var remaining = state.endTime - Date.now();
    if (remaining <= 0) {
        finishSession();
        return;
    }
    timerDisplay.textContent = formatTime(remaining);
    updateRing(remaining);
    state.rafId = requestAnimationFrame(tick);
}

// ─── Controls ────────────────────────────────────────────────────────────────
btnStart.addEventListener('click', function() {
    if (state.finished) {
        resetSession();
        return;
    }
    if (state.running) {
        pauseSession();
    } else {
        startSession();
    }
});

btnReset.addEventListener('click', function() {
    resetSession();
});

function startSession() {
    if (state.durationMs < 1000) return;

    var resuming = state.remainingOnPause !== null;
    var ms = resuming ? state.remainingOnPause : state.durationMs;
    state.endTime = Date.now() + ms;
    state.remainingOnPause = null;
    state.running = true;
    state.finished = false;

    btnStart.textContent = '⏸';
    btnReset.disabled = false;
    statusMsg.textContent = 'meditando';
    statusMsg.classList.add('active');
    timerRing.classList.add('running');
    ringProgress.classList.remove('finished');
    finishedGlow.classList.remove('show');

    acquireWakeLock();

    if (!resuming) {
        playStartBells();
        setStatus('comenzando…');
        setTimeout(function() {
            if (state.running) setStatus('meditando');
        }, 5000);
    }

    state.rafId = requestAnimationFrame(tick);
}

function pauseSession() {
    state.running = false;
    state.remainingOnPause = state.endTime - Date.now();
    if (state.rafId) cancelAnimationFrame(state.rafId);

    releaseWakeLock();
    btnStart.textContent = '▶';
    timerRing.classList.remove('running');
    setStatus('en pausa');
}

function finishSession() {
    state.running = false;
    state.finished = true;
    if (state.rafId) cancelAnimationFrame(state.rafId);

    timerDisplay.textContent = '00:00';
    ringProgress.style.strokeDashoffset = CIRCUMFERENCE;
    ringProgress.classList.add('finished');
    timerRing.classList.remove('running');
    timerLabel.textContent = '✦';
    finishedGlow.classList.add('show');
    setStatus('sesión completada');
    statusMsg.classList.add('active');

    btnStart.textContent = '↺';
    releaseWakeLock();
    playEndBells();
}

function resetSession() {
    state.running = false;
    state.finished = false;
    state.endTime = null;
    state.remainingOnPause = null;
    if (state.rafId) cancelAnimationFrame(state.rafId);

    releaseWakeLock();
    btnStart.textContent = '▶';
    btnReset.disabled = true;
    timerLabel.textContent = '';
    resetDisplay();
}

function setStatus(msg) {
    statusMsg.textContent = msg;
}

// ─── Init ────────────────────────────────────────────────────────────────────
(function init() {
    // Activate 10-min preset by default
    var defaultBtn = document.querySelector('[data-mins="10"]');
    if (defaultBtn) setPreset(defaultBtn, 10);
    btnReset.disabled = true;

    if ('serviceWorker' in navigator) {
        navigator.serviceWorker.register('./sw.js').catch(function() {});
    }
})();
