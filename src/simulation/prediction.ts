import {
  AgentPrediction,
  PredictedStep,
  RoadSample,
  TrackedObject,
} from '../types/simulation';
import { sampleRoadAtS } from './roadMath';

const HORIZON_TIMES = [0.5, 1.0, 1.5, 2.0, 2.5];

export function predictAgentMotions(
  trackedObjects: TrackedObject[],
  roadSamples: RoadSample[]
): AgentPrediction[] {
  const predictions: AgentPrediction[] = [];

  for (let i = 0; i < trackedObjects.length; i++) {
    const obj = trackedObjects[i];
    // Limit predictions to relevant range (< 50m)
    if (obj.dist > 50) continue;

    let latGrowthPerS = 0.22;
    let lonGrowthPerS = 0.26;
    let entropyScore = 0.25;

    switch (obj.agentClass) {
      case 'cattle':
        latGrowthPerS = 0.62;
        lonGrowthPerS = 0.55;
        entropyScore = 0.92;
        break;
      case 'pedestrian':
        latGrowthPerS = 0.48;
        lonGrowthPerS = 0.46;
        entropyScore = 0.82;
        break;
      case 'auto_rickshaw':
        latGrowthPerS = 0.38;
        lonGrowthPerS = 0.32;
        entropyScore = 0.64;
        break;
      case 'two_wheeler':
        latGrowthPerS = 0.42;
        lonGrowthPerS = 0.34;
        entropyScore = 0.68;
        break;
      case 'pushcart':
        latGrowthPerS = obj.speed > 0.2 ? 0.3 : 0.08;
        lonGrowthPerS = obj.speed > 0.2 ? 0.3 : 0.08;
        entropyScore = obj.speed > 0.2 ? 0.45 : 0.12;
        break;
      case 'pothole':
      case 'barricade':
        latGrowthPerS = 0.04;
        lonGrowthPerS = 0.04;
        entropyScore = 0.05;
        break;
      default:
        latGrowthPerS = 0.2;
        lonGrowthPerS = 0.28;
        entropyScore = 0.32;
        break;
    }

    const steps: PredictedStep[] = [];
    // If vehicle is aligned with road (not cross-traffic), blend velocity slightly along road curvature
    const roadSnap = sampleRoadAtS(roadSamples, obj.s);
    const roadDot = Math.abs(
      Math.cos(obj.theta) * Math.cos(roadSnap.theta) +
        Math.sin(obj.theta) * Math.sin(roadSnap.theta)
    );
    const followsRoad = roadDot > 0.72 && obj.agentClass !== 'cattle' && obj.agentClass !== 'pedestrian';

    for (let k = 0; k < HORIZON_TIMES.length; k++) {
      const t = HORIZON_TIMES[k];
      let px = obj.x + obj.vx * t;
      let py = obj.y + obj.vy * t;
      let pTheta = obj.theta;

      if (followsRoad && obj.speed > 0.5) {
        const dirSign =
          Math.cos(obj.theta) * Math.cos(roadSnap.theta) +
            Math.sin(obj.theta) * Math.sin(roadSnap.theta) >=
          0
            ? 1
            : -1;
        const futureS = obj.s + dirSign * obj.speed * t;
        const futureSample = sampleRoadAtS(roadSamples, futureS);
        const curveX = futureSample.x + obj.d * futureSample.nx;
        const curveY = futureSample.y + obj.d * futureSample.ny;
        // Blend kinematic extrapolation with road-curved motion
        px = px * 0.4 + curveX * 0.6;
        py = py * 0.4 + curveY * 0.6;
        pTheta = dirSign === 1 ? futureSample.theta : futureSample.theta + Math.PI;
      }

      // Base half-dimensions + time-expanding covariance tube
      const rx = obj.length * 0.5 + lonGrowthPerS * t;
      const ry = obj.width * 0.5 + latGrowthPerS * t;

      steps.push({
        t,
        x: px,
        y: py,
        rx,
        ry,
        theta: pTheta,
      });
    }

    predictions.push({
      trackId: obj.trackId,
      agentClass: obj.agentClass,
      steps,
      entropyScore,
    });
  }

  return predictions;
}
