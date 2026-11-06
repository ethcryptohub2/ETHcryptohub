let sharedAudioContext: AudioContext | null = null;

export async function playSignalAlarm(kind: 'LONG' | 'SHORT' | 'HIGH', volume: number) {
  const AudioContextConstructor = window.AudioContext;
  if (!AudioContextConstructor) throw new Error('Audio playback is not supported by this browser.');
  sharedAudioContext ??= new AudioContextConstructor();
  const context = sharedAudioContext;
  await context.resume();
  const gain = context.createGain();
  gain.gain.value = Math.max(0, Math.min(1, volume));
  gain.connect(context.destination);
  const notes = kind === 'LONG' ? [740, 988] : kind === 'SHORT' ? [523, 392] : [1046, 1318, 1568];
  const now = context.currentTime;
  notes.forEach((frequency, index) => {
    const oscillator = context.createOscillator();
    const noteGain = context.createGain();
    oscillator.type = 'sine';
    oscillator.frequency.value = frequency;
    noteGain.gain.setValueAtTime(0.001, now + index * 0.16);
    noteGain.gain.exponentialRampToValueAtTime(0.55, now + index * 0.16 + 0.025);
    noteGain.gain.exponentialRampToValueAtTime(0.001, now + index * 0.16 + 0.14);
    oscillator.connect(noteGain);
    noteGain.connect(gain);
    oscillator.start(now + index * 0.16);
    oscillator.stop(now + index * 0.16 + 0.15);
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
