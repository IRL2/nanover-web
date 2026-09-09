uniform vec3 uLightDirection;
uniform vec3 uColor;
uniform float uDiffuse;

varying vec3 vNormal;

void main() {
  vec3 n = normalize(vNormal);
  vec3 l = normalize(uLightDirection);
  vec3 color = uColor * clamp(mix(1.0, dot(n, l), uDiffuse), 0.0, 1.0);
  gl_FragColor = vec4(color, 1.0);
  #include <colorspace_fragment>
}
