import type { Accessor, DefaultProps } from "@deck.gl/core";
import { ScatterplotLayer, type ScatterplotLayerProps } from "@deck.gl/layers";

export type ConfidenceRingLayerProps<D = unknown> = ScatterplotLayerProps<D> & {
  /** Confidence in [0, 1]: drives edge sharpness, saturation and opacity. */
  getConfidence?: Accessor<D, number>;
  /** Independent sources (1-4): drives ring density. */
  getRings?: Accessor<D, number>;
};

const defaultProps: DefaultProps<ConfidenceRingLayerProps> = {
  getConfidence: { type: "accessor", value: 1 },
  getRings: { type: "accessor", value: 1 },
};

/**
 * Confidence as a continuous visual property, computed per fragment on the GPU:
 *   ring density    one concentric ring per independent source
 *   edge sharpness  crisp at high confidence, blurred towards low confidence
 *   saturation      full colour when confident, washing to grey when not
 * A fielded COP draws all of these entities with the same symbol.
 */
export class ConfidenceRingLayer<D = unknown, ExtraProps extends {} = {}> extends ScatterplotLayer<D, ExtraProps & Required<Pick<ConfidenceRingLayerProps<D>, "getConfidence" | "getRings">>> {
  static override layerName = "ConfidenceRingLayer";
  static override defaultProps = defaultProps as never;

  override initializeState() {
    super.initializeState();
    this.getAttributeManager()!.addInstanced({
      instanceConfidence: { size: 1, accessor: "getConfidence", defaultValue: 1 },
      instanceRings: { size: 1, accessor: "getRings", defaultValue: 1 },
    });
  }

  override getShaders() {
    const shaders = super.getShaders();
    return {
      ...shaders,
      inject: {
        "vs:#decl": "in float instanceConfidence;\nin float instanceRings;\nout float vConfidence;\nout float vRings;\n",
        "vs:#main-end": "vConfidence = instanceConfidence;\nvRings = instanceRings;\n",
        "fs:#decl": "in float vConfidence;\nin float vRings;\n",
        "fs:DECKGL_FILTER_COLOR": `
          float conf = clamp(vConfidence, 0.0, 1.0);
          float r = length(geometry.uv);
          float soft = mix(0.012, 0.20, 1.0 - conf);
          float rings = clamp(vRings, 1.0, 4.0);
          float ringA = 0.0;
          for (int i = 0; i < 4; i++) {
            if (float(i) >= rings) break;
            float rr = 0.90 - float(i) * 0.15;
            float d = abs(r - rr);
            ringA = max(ringA, 1.0 - smoothstep(0.035, 0.035 + soft, d));
          }
          float fill = (1.0 - smoothstep(0.42 - soft, 0.42 + soft, r)) * (0.10 + 0.22 * conf);
          float lum = dot(color.rgb, vec3(0.299, 0.587, 0.114));
          vec3 rgb = mix(vec3(lum), color.rgb, 0.15 + 0.85 * conf);
          float a = max(ringA * (0.30 + 0.70 * conf), fill);
          color = vec4(rgb, a * color.a);
        `,
      },
    };
  }
}
