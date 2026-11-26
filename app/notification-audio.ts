export type AlertRingtone = 'coin-drop' | 'sharp-bell' | 'digital-beep' | 'high-conviction-siren' | 'custom-mp3';
export type AudioAlarmType = 'signal' | 'execution';
export type AlarmDuration = 3 | 5 | 10 | 'full';

export const ALERT_RINGTONES: Array<{ value: AlertRingtone; label: string }> = [
  { value: 'custom-mp3', label: 'Owner Custom MP3 (alarm_tone / alarm)' },
  { value: 'coin-drop', label: 'Classic Cash / Coin Drop' },
  { value: 'sharp-bell', label: 'Sharp Bell' },
  { value: 'digital-beep', label: 'Digital Beep' },
  { value: 'high-conviction-siren', label: 'High-Conviction Siren' },
];

export const SIGNAL_AUDIO_PATH = '/audio/alarm_tone.mp3';
export const EXECUTION_AUDIO_PATH = '/audio/alarm.mp3';

const RINGTONE_STORAGE_KEY = 'ethcryptohub-alert-ringtone';
const DURATION_STORAGE_KEY = 'ethcryptohub-alert-duration';
const VOLUME_STORAGE_KEY = 'ethcryptohub-alert-volume';
const AUDIO_UNLOCKED_STORAGE_KEY = 'ethcryptohub-audio-unlocked';
const DEFAULT_RINGTONE: AlertRingtone = 'custom-mp3';

let ringtoneSnapshot: AlertRingtone = DEFAULT_RINGTONE;
let sharedAudioContext: AudioContext | null = null;
let activeAudioElement: HTMLAudioElement | null = null;
let activeStopTimer: ReturnType<typeof setTimeout> | null = null;
let broadcastChannel: BroadcastChannel | null = null;

// Unique tab ID for cross-tab audio coordination
const TAB_ID = typeof crypto !== 'undefined' && crypto.randomUUID ? crypto.randomUUID() : `tab-${Date.now()}-${Math.random()}`;

if (typeof window !== 'undefined') {
  try {
    if ('BroadcastChannel' in window) {
      broadcastChannel = new BroadcastChannel('smartexit-audio-coordination');
      broadcastChannel.onmessage = (event) => {
        if (event.data?.type === 'STOP_ALARM' || event.data?.type === 'PLAYING_ALARM') {
          // If another tab started playing or asked to stop, stop any active local audio
          if (event.data?.tabId !== TAB_ID) {
            internalStop();
          }
        }
      };
    }
  } catch {
    // Graceful fallback
  }
}

function internalStop() {
  if (activeStopTimer) {
    clearTimeout(activeStopTimer);
    activeStopTimer = null;
  }
  if (activeAudioElement) {
    activeAudioElement.pause();
    activeAudioElement.currentTime = 0;
    activeAudioElement = null;
  }
}

export function stopAlarm(): void {
  internalStop();
  try {
    broadcastChannel?.postMessage({ type: 'STOP_ALARM', tabId: TAB_ID });
    localStorage.setItem('ethcryptohub-active-alarm', JSON.stringify({ action: 'stop', timestamp: Date.now() }));
  } catch {
    // Ignore storage issues
  }
}

function isAlertRingtone(value: string | null): value is AlertRingtone {
  return ALERT_RINGTONES.some((ringtone) => ringtone.value === value);
}

export function getSelectedAlertRingtone(): AlertRingtone {
  if (typeof window === 'undefined') return DEFAULT_RINGTONE;
  try {
    const saved = window.localStorage.getItem(RINGTONE_STORAGE_KEY);
    if (isAlertRingtone(saved)) ringtoneSnapshot = saved;
  } catch (error) {
    console.error('Unable to read the saved alert ringtone:', error);
  }
  return ringtoneSnapshot;
}

export function setSelectedAlertRingtone(ringtone: AlertRingtone): void {
  ringtoneSnapshot = ringtone;
  if (typeof window === 'undefined') return;
  try {
    window.localStorage.setItem(RINGTONE_STORAGE_KEY, ringtone);
  } catch (error) {
    console.error('Unable to save the alert ringtone preference:', error);
  }
}

export function getAlarmDuration(): AlarmDuration {
  if (typeof window === 'undefined') return 5;
  try {
    const saved = window.localStorage.getItem(DURATION_STORAGE_KEY);
    if (saved === '3' || saved === '5' || saved === '10' || saved === 'full') {
      return saved === 'full' ? 'full' : Number(saved) as 3 | 5 | 10;
    }
  } catch {}
  return 5;
}

export function setAlarmDuration(duration: AlarmDuration): void {
  if (typeof window === 'undefined') return;
  try {
    window.localStorage.setItem(DURATION_STORAGE_KEY, String(duration));
  } catch {}
}

export function getAlarmVolume(): number {
  if (typeof window === 'undefined') return 0.8;
  try {
    const saved = window.localStorage.getItem(VOLUME_STORAGE_KEY);
    if (saved !== null) {
      const parsed = parseFloat(saved);
      if (!isNaN(parsed) && parsed >= 0 && parsed <= 1) return parsed;
    }
  } catch {}
  return 0.8;
}

export function setAlarmVolume(volume: number): void {
  if (typeof window === 'undefined') return;
  try {
    const clamped = Math.max(0, Math.min(1, volume));
    window.localStorage.setItem(VOLUME_STORAGE_KEY, clamped.toFixed(2));
  } catch {}
}

export function isAudioUnlocked(): boolean {
  if (typeof window === 'undefined') return false;
  try {
    return window.sessionStorage.getItem(AUDIO_UNLOCKED_STORAGE_KEY) === 'true';
  } catch {
    return false;
  }
}

export async function unlockAudio(): Promise<boolean> {
  if (typeof window === 'undefined') return false;
  try {
    const AudioContextConstructor = window.AudioContext;
    if (AudioContextConstructor) {
      sharedAudioContext ??= new AudioContextConstructor();
      if (sharedAudioContext.state === 'suspended') {
        await sharedAudioContext.resume();
      }
    }
    window.sessionStorage.setItem(AUDIO_UNLOCKED_STORAGE_KEY, 'true');
    return true;
  } catch (err) {
    console.warn('Audio autoplay unlock failed:', err);
    return false;
  }
}

type Note = { frequency: number; start: number; duration: number; type?: OscillatorType };

function ringtoneNotes(ringtone: AlertRingtone): Note[] {
  switch (ringtone) {
    case 'coin-drop':
    case 'custom-mp3':
      return [
        { frequency: 1318, start: 0, duration: 0.11, type: 'sine' },
        { frequency: 1760, start: 0.1, duration: 0.12, type: 'triangle' },
        { frequency: 1318, start: 0.24, duration: 0.1, type: 'sine' },
        { frequency: 988, start: 0.37, duration: 0.28, type: 'sine' },
      ];
    case 'sharp-bell':
      return [
        { frequency: 1760, start: 0, duration: 0.34, type: 'triangle' },
        { frequency: 2349, start: 0.03, duration: 0.24, type: 'sine' },
        { frequency: 1760, start: 0.48, duration: 0.34, type: 'triangle' },
        { frequency: 2349, start: 0.51, duration: 0.24, type: 'sine' },
      ];
    case 'digital-beep':
      return [
        { frequency: 1046, start: 0, duration: 0.12, type: 'square' },
        { frequency: 1397, start: 0.17, duration: 0.12, type: 'square' },
        { frequency: 1046, start: 0.34, duration: 0.12, type: 'square' },
        { frequency: 1397, start: 0.51, duration: 0.12, type: 'square' },
      ];
    case 'high-conviction-siren':
      return [
        { frequency: 880, start: 0, duration: 0.2, type: 'sawtooth' },
        { frequency: 1320, start: 0.22, duration: 0.2, type: 'sawtooth' },
        { frequency: 880, start: 0.44, duration: 0.2, type: 'sawtooth' },
        { frequency: 1320, start: 0.66, duration: 0.2, type: 'sawtooth' },
        { frequency: 1760, start: 0.9, duration: 0.24, type: 'triangle' },
      ];
  }
}

export async function playSynthesizedAlarm(
  volume: number,
  ringtone: AlertRingtone = 'coin-drop',
) {
  if (typeof window === 'undefined') return;
  const AudioContextConstructor = window.AudioContext;
  if (!AudioContextConstructor) throw new Error('Audio playback is not supported by this browser.');
  sharedAudioContext ??= new AudioContextConstructor();
  const context = sharedAudioContext;
  if (context.state === 'suspended') {
    await context.resume();
  }
  const gain = context.createGain();
  gain.gain.value = Math.max(0, Math.min(1, volume));
  gain.connect(context.destination);
  const now = context.currentTime;

  ringtoneNotes(ringtone).forEach(({ frequency, start, duration, type = 'sine' }) => {
    const oscillator = context.createOscillator();
    const noteGain = context.createGain();
    const noteStart = now + start;
    oscillator.type = type;
    oscillator.frequency.value = frequency;
    noteGain.gain.setValueAtTime(0.001, noteStart);
    noteGain.gain.exponentialRampToValueAtTime(type === 'sawtooth' || type === 'square' ? 0.3 : 0.48, noteStart + 0.012);
    noteGain.gain.exponentialRampToValueAtTime(0.001, noteStart + duration);
    oscillator.connect(noteGain);
    noteGain.connect(gain);
    oscillator.start(noteStart);
    oscillator.stop(noteStart + duration + 0.01);
  });
}

// Master Audio Alarm function
export async function playAlarm(
  type: AudioAlarmType = 'signal',
  options: {
    volume?: number;
    duration?: AlarmDuration;
    ringtone?: AlertRingtone;
    force?: boolean;
  } = {},
): Promise<{ success: boolean; mode: 'mp3' | 'synthesizer' | 'blocked' }> {
  if (typeof window === 'undefined') return { success: false, mode: 'blocked' };

  // Do not play alarms on the login page
  if (window.location.pathname === '/login' && !options.force) {
    return { success: false, mode: 'blocked' };
  }

  // Cross-tab coordination: check if another tab is currently playing
  const nowMs = Date.now();
  try {
    const lock = JSON.parse(localStorage.getItem('ethcryptohub-active-alarm') || '{}');
    if (lock.tabId && lock.tabId !== TAB_ID && lock.expiresAt && lock.expiresAt > nowMs && !options.force) {
      // Another tab is playing this alarm right now; skip local duplicate
      return { success: false, mode: 'blocked' };
    }
  } catch {}

  const volume = options.volume ?? getAlarmVolume();
  const duration = options.duration ?? getAlarmDuration();
  const ringtone = options.ringtone ?? getSelectedAlertRingtone();

  // Stop any currently playing audio in this tab
  internalStop();

  // Notify other tabs that this tab is taking ownership of audio playback
  const playbackLimitSec = duration === 'full' ? 30 : duration;
  try {
    broadcastChannel?.postMessage({ type: 'PLAYING_ALARM', tabId: TAB_ID });
    localStorage.setItem(
      'ethcryptohub-active-alarm',
      JSON.stringify({ tabId: TAB_ID, timestamp: nowMs, expiresAt: nowMs + playbackLimitSec * 1000 }),
    );
  } catch {}

  // Determine MP3 path: signal uses alarm_tone.mp3, execution uses alarm.mp3
  const mp3Path = type === 'execution' ? EXECUTION_AUDIO_PATH : SIGNAL_AUDIO_PATH;

  if (ringtone === 'custom-mp3') {
    try {
      const audio = new Audio(mp3Path);
      audio.volume = Math.max(0, Math.min(1, volume));
      activeAudioElement = audio;

      await audio.play();

      // If duration is numeric (3, 5, 10), schedule pause
      if (typeof duration === 'number') {
        activeStopTimer = setTimeout(() => {
          internalStop();
        }, duration * 1000);
      }

      audio.onended = () => {
        internalStop();
      };

      return { success: true, mode: 'mp3' };
    } catch (error) {
      console.warn(`HTML5 Audio playback for ${mp3Path} failed, falling back to Web Audio oscillator:`, error);
      // Fallback to Web Audio oscillator
    }
  }

  // Fallback or explicit ringtone: play Web Audio oscillator notes
  try {
    await playSynthesizedAlarm(volume, ringtone === 'custom-mp3' ? 'coin-drop' : ringtone);
    return { success: true, mode: 'synthesizer' };
  } catch (error) {
    console.warn('Synthesized alarm playback blocked or failed:', error);
    return { success: false, mode: 'blocked' };
  }
}

// Backwards compatibility alias
export const playSignalAlarm = playSynthesizedAlarm;

export function isWithinClientQuietHours(
  start: string,
  end: string,
  timezone: string,
  enabled: boolean,
) {
  if (!enabled) return false;
  try {
    const parts = new Intl.DateTimeFormat('en-US', {
      timeZone: timezone,
      hour: '2-digit',
      minute: '2-digit',
      hourCycle: 'h23',
    }).formatToParts(new Date());
    const hour = Number(parts.find((part) => part.type === 'hour')?.value);
    const minute = Number(parts.find((part) => part.type === 'minute')?.value);
    const now = hour * 60 + minute;
    const [startHour, startMinute] = start.split(':').map(Number);
    const [endHour, endMinute] = end.split(':').map(Number);
    const startAt = startHour! * 60 + startMinute!;
    const endAt = endHour! * 60 + endMinute!;
    if (startAt === endAt) return true;
    return startAt < endAt ? now >= startAt && now < endAt : now >= startAt || now < endAt;
  } catch {
    return true;
  }
}
