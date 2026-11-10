export type AlertRingtone = 'coin-drop' | 'sharp-bell' | 'digital-beep' | 'high-conviction-siren';

export const ALERT_RINGTONES: Array<{ value: AlertRingtone; label: string }> = [
  { value: 'coin-drop', label: 'Classic Cash / Coin Drop' },
  { value: 'sharp-bell', label: 'Sharp Bell' },
  { value: 'digital-beep', label: 'Digital Beep' },
  { value: 'high-conviction-siren', label: 'High-Conviction Siren' },
];

const RINGTONE_STORAGE_KEY = 'ethcryptohub-alert-ringtone';
const DEFAULT_RINGTONE: AlertRingtone = 'coin-drop';
let ringtoneSnapshot: AlertRingtone = DEFAULT_RINGTONE;
let sharedAudioContext: AudioContext | null = null;

function isAlertRingtone(value: string | null): value is AlertRingtone {
  return ALERT_RINGTONES.some((ringtone) => ringtone.value === value);
}

export function getSelectedAlertRingtone(): AlertRingtone {
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
  try {
    window.localStorage.setItem(RINGTONE_STORAGE_KEY, ringtone);
  } catch (error) {
    console.error('Unable to save the alert ringtone preference:', error);
  }
}

type Note = { frequency: number; start: number; duration: number; type?: OscillatorType };

function ringtoneNotes(ringtone: AlertRingtone): Note[] {
  switch (ringtone) {
    case 'coin-drop':
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

export async function playSignalAlarm(
  volume: number,
  ringtone: AlertRingtone = getSelectedAlertRingtone(),
) {
  const AudioContextConstructor = window.AudioContext;
  if (!AudioContextConstructor) throw new Error('Audio playback is not supported by this browser.');
  sharedAudioContext ??= new AudioContextConstructor();
  const context = sharedAudioContext;
  await context.resume();
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
