import React, { useEffect, useMemo, useRef, useState } from "react";

// --- Simple helpers ---
function classNames(...xs) {
  return xs.filter(Boolean).join(" ");
}

// Very small LRC parser (lines like: [mm:ss.xx] lyric)
function parseLRC(text) {
  const lines = text.split(/\r?\n/).filter(Boolean);
  const entries = [];
  for (const line of lines) {
    const match = line.match(/^\s*\[(\d{1,2}):(\d{1,2})(?:\.(\d{1,2}))?\]\s*(.*)$/);
    if (match) {
      const m = parseInt(match[1]);
      const s = parseInt(match[2]);
      const cs = match[3] ? parseInt(match[3]) : 0;
      const t = m * 60 + s + cs / 100;
      entries.push({ time: t, text: match[4] || "" });
    } else {
      entries.push({ time: null, text: line.trim() });
    }
  }
  let lastTime = 0;
  const spaced = entries.map((e, i) => {
    if (e.time == null) {
      lastTime += 2.5;
      return { ...e, time: lastTime };
    } else {
      lastTime = e.time;
      return e;
    }
  });
  return spaced.sort((a, b) => a.time - b.time);
}

// Create a synthetic impulse response for a basic reverb
function createImpulseResponse(ctx, duration = 1.5, decay = 2.5) {
  const rate = ctx.sampleRate;
  const len = rate * duration;
  const impulse = ctx.createBuffer(2, len, rate);
  for (let ch = 0; ch < 2; ch++) {
    const data = impulse.getChannelData(ch);
    for (let i = 0; i < len; i++) {
      data[i] = (Math.random() * 2 - 1) * Math.pow(1 - i / len, decay);
    }
  }
  return impulse;
}

export default function App() {
  const [instrumentalFile, setInstrumentalFile] = useState(null);
  const [lrcText, setLrcText] = useState(`[# Exemplo LRC — cole sua letra aqui]
[00:00.00] KaraoKria — solta a voz!
[00:04.00] Entra no beat, sente a vibração
[00:08.00] Cidade acesa, cria no refrão
[00:12.00] Canta alto, vive a emoção
[00:16.00] KaraoKria, a nova versão`);
  const [parsedLRC, setParsedLRC] = useState([]);
  const [currentIndex, setCurrentIndex] = useState(0);

  const audioRef = useRef(null);
  const [isPlaying, setIsPlaying] = useState(false);
  const [volume, setVolume] = useState(0.9);
  const [tempo, setTempo] = useState(1);

  const [micOn, setMicOn] = useState(false);
  const audioCtxRef = useRef(null);
  const micNodesRef = useRef({});

  const [echoOn, setEchoOn] = useState(true);
  const [reverbOn, setReverbOn] = useState(true);
  const [distOn, setDistOn] = useState(false);

  useEffect(() => {
    setParsedLRC(parseLRC(lrcText));
  }, []);

  useEffect(() => {
    const p = parseLRC(lrcText);
    setParsedLRC(p);
  }, [lrcText]);

  useEffect(() => {
    const audio = audioRef.current;
    if (!audio) return;
    let raf;
    const tick = () => {
      if (isNaN(audio.currentTime)) return (raf = requestAnimationFrame(tick));
      const t = audio.currentTime;
      let idx = parsedLRC.findIndex((e, i) => {
        const next = parsedLRC[i + 1];
        return t >= e.time && (!next || t < next.time);
      });
      if (idx === -1 && parsedLRC.length) idx = parsedLRC.length - 1;
      setCurrentIndex(idx);
      raf = requestAnimationFrame(tick);
    };
    raf = requestAnimationFrame(tick);
    return () => cancelAnimationFrame(raf);
  }, [parsedLRC]);

  const onPickInstrumental = (file) => {
    setInstrumentalFile(file);
    const url = URL.createObjectURL(file);
    const audio = audioRef.current;
    if (audio) {
      audio.src = url;
      audio.playbackRate = tempo;
      audio.volume = volume;
    }
  };

  const togglePlay = async () => {
    const a = audioRef.current;
    if (!a || !a.src) return;
    if (a.paused) {
      await a.play();
      setIsPlaying(true);
    } else {
      a.pause();
      setIsPlaying(false);
    }
  };

  useEffect(() => {
    if (audioRef.current) audioRef.current.volume = volume;
  }, [volume]);
  useEffect(() => {
    if (audioRef.current) audioRef.current.playbackRate = tempo;
  }, [tempo]);

  const ensureAudioCtx = () => {
    if (!audioCtxRef.current) {
      audioCtxRef.current = new (window.AudioContext || window.webkitAudioContext)();
    }
    return audioCtxRef.current;
  };

  const toggleMic = async () => {
    if (micOn) {
      const { stream, nodes } = micNodesRef.current;
      if (stream) {
        stream.getTracks().forEach((t) => t.stop());
      }
      nodes?.forEach?.((n) => n.disconnect?.());
      micNodesRef.current = {};
      setMicOn(false);
      return;
    }

    try {
      const ctx = ensureAudioCtx();
      const stream = await navigator.mediaDevices.getUserMedia({ audio: true });
      const src = ctx.createMediaStreamSource(stream);
      const gain = ctx.createGain();
      gain.gain.value = 1.0;

      const delay = ctx.createDelay(1.0);
      delay.delayTime.value = echoOn ? 0.18 : 0.0;
      const fb = ctx.createGain();
      fb.gain.value = echoOn ? 0.25 : 0.0;
      delay.connect(fb);
      fb.connect(delay);

      const convolver = ctx.createConvolver();
      convolver.buffer = createImpulseResponse(ctx, 1.6, 2.8);

      const waveShaper = ctx.createWaveShaper();
      const curve = new Float32Array(44100);
      for (let i = 0; i < curve.length; i++) {
        const x = (i / curve.length) * 2 - 1;
        curve[i] = ((1 + 3) * x) / (1 + 3 * Math.abs(x));
      }
      waveShaper.curve = curve;

      const destination = ctx.destination;

      const dry = ctx.createGain();
      dry.gain.value = 0.9;

      const wet = ctx.createGain();
      wet.gain.value = 0.8;

      src.connect(gain);

      gain.connect(delay);
      let last = delay;
      if (distOn) {
        last.connect(waveShaper);
        last = waveShaper;
      }
      last.connect(convolver);

      gain.connect(dry);
      convolver.connect(wet);

      const master = ctx.createGain();
      master.gain.value = 1.0;

      dry.connect(master);
      wet.connect(master);

      master.connect(destination);

      micNodesRef.current = { stream, nodes: [src, gain, delay, fb, convolver, waveShaper, dry, wet, master] };
      setMicOn(true);
    } catch (e) {
      alert("Falha ao acessar o microfone: " + e.message);
    }
  };

  useEffect(() => {
    if (!micOn) return;
    toggleMic();
    setTimeout(() => toggleMic(), 50);
  }, [echoOn, reverbOn, distOn]);

  const activeLineRef = useRef(null);
  useEffect(() => {
    activeLineRef.current?.scrollIntoView({ behavior: "smooth", block: "center" });
  }, [currentIndex]);

  return (
    <div className="min-h-screen bg-black text-white">
      <h1 className="text-3xl font-bold text-center py-6">KaraoKria 🎤</h1>
      <div className="mx-auto max-w-4xl px-6 py-6">
        <input type="file" accept="audio/*" onChange={(e) => onPickInstrumental(e.target.files?.[0])} />
        <button onClick={togglePlay} className="ml-4 px-4 py-2 bg-white text-black rounded">{isPlaying ? "Pausar" : "Tocar"}</button>
        <button onClick={toggleMic} className="ml-4 px-4 py-2 border rounded">{micOn ? "Desligar Mic" : "Ligar Mic"}</button>

        <div className="mt-6 border p-4 rounded h-64 overflow-y-auto bg-white/5">
          {parsedLRC.map((line, i) => (
            <div key={i} ref={i === currentIndex ? activeLineRef : undefined} className={i === currentIndex ? "text-white font-bold" : "text-white/60"}>
              {line.text}
            </div>
          ))}
        </div>

        <textarea className="mt-6 w-full h-40 bg-black/40 border rounded p-2" value={lrcText} onChange={(e) => setLrcText(e.target.value)} />
      </div>
      <audio ref={audioRef} className="hidden" />
    </div>
  );
}
