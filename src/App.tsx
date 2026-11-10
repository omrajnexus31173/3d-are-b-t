import { useCallback, useEffect, useRef, useState } from 'react';
import { Simulation3DViewport } from './components/Simulation3DViewport';
import { SimulationCanvas } from './components/SimulationCanvas';
import { TechnicalReportModal } from './components/TechnicalReportModal';
import { TelemetrySidebar } from './components/TelemetrySidebar';
import { TopBar } from './components/TopBar';
import { ValidationModal } from './components/ValidationModal';
import {
  createInitialSimulationState,
  HazardInjectionType,
  injectDynamicHazard,
  stepSimulation,
} from './simulation/engine';
import { SCENARIO_IDS } from './simulation/scenarios';
import {
  LayerVisibility,
  ScenarioId,
  SensorNoiseConfig,
  SimulationState,
} from './types/simulation';

export function App() {
  const [activeScenarioId, setActiveScenarioId] = useState<ScenarioId>('village_road');
  const simStateRef = useRef<SimulationState>(
    createInitialSimulationState('village_road', true)
  );
  const [uiSnapshot, setUiSnapshot] = useState<SimulationState>(() => ({
    ...simStateRef.current,
  }));

  const [running, setRunning] = useState(true);
  const [simSpeed, setSimSpeed] = useState(1);
  const [autoDemo, setAutoDemo] = useState(false);
  const [isRecording, setIsRecording] = useState(false);
  const [viewMode, setViewMode] = useState<'3d' | '2d'>('3d');
  const [weatherMode, setWeatherMode] =
    useState<SensorNoiseConfig['weatherMode']>('clear');

  const [completedScenarios, setCompletedScenarios] = useState<Record<ScenarioId, boolean>>({
    village_road: false,
    urban_intersection: false,
    highway_merge: false,
    dense_market: false,
    cattle_crossing: false,
  });

  const [layers, setLayers] = useState<LayerVisibility>({
    lidar: true,
    cameraFov: true,
    radar: false,
    predictions: true,
    candidates: true,
    corridor: true,
    labels: true,
  });

  const [validationOpen, setValidationOpen] = useState(false);
  const [reportOpen, setReportOpen] = useState(false);

  const canvasElementRef = useRef<HTMLCanvasElement | null>(null);
  const mediaRecorderRef = useRef<MediaRecorder | null>(null);
  const recordedChunksRef = useRef<Blob[]>([]);
  const autoDemoTimerRef = useRef<number | null>(null);

  const getNoiseConfig = useCallback((): SensorNoiseConfig => {
    return {
      weatherMode,
      noiseMultiplier:
        weatherMode === 'clear' ? 1.0 : weatherMode === 'monsoon_haze' ? 1.8 : 1.55,
    };
  }, [weatherMode]);

  const loadScenario = useCallback((id: ScenarioId, autoRun = true) => {
    if (autoDemoTimerRef.current !== null) {
      window.clearTimeout(autoDemoTimerRef.current);
      autoDemoTimerRef.current = null;
    }
    const fresh = createInitialSimulationState(id, autoRun);
    simStateRef.current = fresh;
    setActiveScenarioId(id);
    setRunning(autoRun);
    setUiSnapshot({ ...fresh });
  }, []);

  const handleReset = useCallback(() => {
    loadScenario(activeScenarioId, true);
  }, [activeScenarioId, loadScenario]);

  const handleStepOnce = useCallback(() => {
    const sim = simStateRef.current;
    if (sim.metrics.completed) return;
    stepSimulation(sim, 0.05, getNoiseConfig());
    setUiSnapshot({ ...sim, metrics: { ...sim.metrics }, logs: [...sim.logs] });
  }, [getNoiseConfig]);

  const handleToggleLayer = (key: keyof LayerVisibility) => {
    setLayers((prev) => ({ ...prev, [key]: !prev[key] }));
  };

  const handleInjectHazard = (kind: HazardInjectionType) => {
    const sim = simStateRef.current;
    injectDynamicHazard(sim, kind);
    setUiSnapshot({ ...sim, logs: [...sim.logs] });
  };

  const handleCycleWeather = () => {
    setWeatherMode((prev) =>
      prev === 'clear'
        ? 'monsoon_haze'
        : prev === 'monsoon_haze'
        ? 'dust_glare'
        : 'clear'
    );
  };

  const handleToggleRecord = () => {
    if (isRecording) {
      try {
        mediaRecorderRef.current?.stop();
      } catch {
        // ignore stop error
      }
      setIsRecording(false);
      return;
    }

    const canvas = canvasElementRef.current;
    if (!canvas || typeof canvas.captureStream !== 'function' || typeof MediaRecorder === 'undefined') {
      alert('Canvas video recording is not supported in this browser environment.');
      return;
    }

    try {
      const stream = canvas.captureStream(30);
      const mimeType = MediaRecorder.isTypeSupported('video/webm;codecs=vp9')
        ? 'video/webm;codecs=vp9'
        : 'video/webm';
      const recorder = new MediaRecorder(stream, { mimeType });
      recordedChunksRef.current = [];

      recorder.ondataavailable = (ev) => {
        if (ev.data && ev.data.size > 0) {
          recordedChunksRef.current.push(ev.data);
        }
      };

      recorder.onstop = () => {
        const blob = new Blob(recordedChunksRef.current, { type: 'video/webm' });
        if (blob.size > 0) {
          const url = URL.createObjectURL(blob);
          const a = document.createElement('a');
          a.href = url;
          a.download = `bharat-av-${activeScenarioId}-demo.webm`;
          a.click();
          URL.revokeObjectURL(url);
        }
      };

      recorder.start(250);
      mediaRecorderRef.current = recorder;
      setIsRecording(true);
    } catch {
      alert('Unable to initialize canvas video capture on this device.');
    }
  };

  // Keyboard shortcuts (Space = Play/Pause, R = Reset, 1-5 = Scenarios)
  useEffect(() => {
    const onKeyDown = (e: KeyboardEvent) => {
      if (validationOpen || reportOpen) return;
      if (e.code === 'Space') {
        e.preventDefault();
        setRunning((r) => !r);
      } else if (e.key === 'r' || e.key === 'R') {
        handleReset();
      } else if (['1', '2', '3', '4', '5'].includes(e.key)) {
        const idx = Number(e.key) - 1;
        if (SCENARIO_IDS[idx]) loadScenario(SCENARIO_IDS[idx], true);
      }
    };
    window.addEventListener('keydown', onKeyDown);
    return () => window.removeEventListener('keydown', onKeyDown);
  }, [validationOpen, reportOpen, handleReset, loadScenario]);

  // Main real-time physics loop (fixed 40ms sub-step, ~15Hz UI snapshot sync)
  useEffect(() => {
    if (!running) return;
    let rafId = 0;
    let lastFrameTime = performance.now();
    let accumulator = 0;
    let lastUiSync = 0;
    const fixedDt = 0.04;

    const tick = (now: number) => {
      const elapsedSec = Math.min(0.1, (now - lastFrameTime) / 1000);
      lastFrameTime = now;
      accumulator += elapsedSec * simSpeed;

      const sim = simStateRef.current;
      const noiseCfg = getNoiseConfig();

      let stepsThisFrame = 0;
      while (accumulator >= fixedDt && stepsThisFrame < 5) {
        if (!sim.metrics.completed) {
          stepSimulation(sim, fixedDt, noiseCfg);
        }
        accumulator -= fixedDt;
        stepsThisFrame += 1;
      }

      if (sim.metrics.completed) {
        setCompletedScenarios((prev) =>
          prev[sim.scenario.id] ? prev : { ...prev, [sim.scenario.id]: sim.metrics.passed }
        );
      }

      if (now - lastUiSync >= 75 || sim.metrics.completed) {
        lastUiSync = now;
        setUiSnapshot({
          ...sim,
          ego: { ...sim.ego },
          metrics: { ...sim.metrics },
          planner: { ...sim.planner },
          perception: { ...sim.perception },
          telemetryHistory: [...sim.telemetryHistory],
          logs: [...sim.logs],
        });
      }

      if (!sim.metrics.completed) {
        rafId = requestAnimationFrame(tick);
      } else {
        setRunning(false);
      }
    };

    rafId = requestAnimationFrame(tick);
    return () => cancelAnimationFrame(rafId);
  }, [running, simSpeed, getNoiseConfig]);

  // Auto-Demo Tour sequentially cycles across all 5 scenarios
  useEffect(() => {
    if (!autoDemo) {
      if (autoDemoTimerRef.current !== null) {
        window.clearTimeout(autoDemoTimerRef.current);
        autoDemoTimerRef.current = null;
      }
      return;
    }

    if (uiSnapshot.metrics.completed) {
      autoDemoTimerRef.current = window.setTimeout(() => {
        const curIdx = SCENARIO_IDS.indexOf(activeScenarioId);
        const nextId = SCENARIO_IDS[(curIdx + 1) % SCENARIO_IDS.length];
        loadScenario(nextId, true);
      }, 2200);
    }
  }, [autoDemo, uiSnapshot.metrics.completed, activeScenarioId, loadScenario]);

  return (
    <div className="min-h-screen lg:h-screen lg:overflow-hidden flex flex-col bg-[#0B0F17] text-slate-100">
      <TopBar
        activeScenarioId={activeScenarioId}
        completedScenarios={completedScenarios}
        running={running}
        simSpeed={simSpeed}
        autoDemo={autoDemo}
        isRecording={isRecording}
        weatherMode={weatherMode}
        viewMode={viewMode}
        onChangeViewMode={setViewMode}
        onSelectScenario={(id) => loadScenario(id, true)}
        onToggleRun={() => {
          if (simStateRef.current.metrics.completed) {
            handleReset();
          } else {
            setRunning((r) => !r);
          }
        }}
        onStepOnce={handleStepOnce}
        onReset={handleReset}
        onChangeSimSpeed={setSimSpeed}
        onToggleAutoDemo={() => {
          setAutoDemo((prev) => {
            const next = !prev;
            if (next && simStateRef.current.metrics.completed) {
              const curIdx = SCENARIO_IDS.indexOf(activeScenarioId);
              const nextId = SCENARIO_IDS[(curIdx + 1) % SCENARIO_IDS.length];
              loadScenario(nextId, true);
            } else if (next && !running) {
              setRunning(true);
            }
            return next;
          });
        }}
        onToggleRecord={handleToggleRecord}
        onCycleWeather={handleCycleWeather}
        onOpenValidation={() => setValidationOpen(true)}
        onOpenReport={() => setReportOpen(true)}
      />

      {/* Main Split Workspace: Interactive 3D WebGL Viewport (or 2D Tactical View) + Diagnostics Sidebar */}
      <main className="flex-1 min-h-0 flex flex-col lg:flex-row">
        <div className="h-[58vh] lg:h-full flex-1 min-w-0 flex flex-col">
          {viewMode === '3d' ? (
            <Simulation3DViewport
              simStateRef={simStateRef}
              uiSnapshot={uiSnapshot}
              layers={layers}
              weatherMode={weatherMode}
              isRecording={isRecording}
              onToggleLayer={handleToggleLayer}
              onInjectHazard={handleInjectHazard}
              canvasElementRef={canvasElementRef}
            />
          ) : (
            <SimulationCanvas
              simStateRef={simStateRef}
              uiSnapshot={uiSnapshot}
              layers={layers}
              weatherMode={weatherMode}
              isRecording={isRecording}
              onToggleLayer={handleToggleLayer}
              onInjectHazard={handleInjectHazard}
              canvasElementRef={canvasElementRef}
            />
          )}
        </div>

        <TelemetrySidebar sim={uiSnapshot} />
      </main>

      <ValidationModal
        open={validationOpen}
        onClose={() => setValidationOpen(false)}
        onJumpToScenario={(id) => loadScenario(id, true)}
      />

      <TechnicalReportModal
        open={reportOpen}
        onClose={() => setReportOpen(false)}
      />
    </div>
  );
}

export default App;
