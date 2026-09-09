attribute vec3 aStartPoint;
attribute vec3 aEndPoint;
attribute vec3 aStartTangent;
attribute vec3 aEndTangent;
attribute vec3 aStartNormal;
attribute vec3 aEndNormal;

uniform float uRadius;

varying vec3 vNormal;

vec3 hermitePoint(float t, vec3 p1, vec3 m1, vec3 p2, vec3 m2) {
  float t2 = t * t;
  float t3 = t2 * t;
  return (2.0 * t3 - 3.0 * t2 + 1.0) * p1
       + (t3 - 2.0 * t2 + t) * m1
       + (-2.0 * t3 + 3.0 * t2) * p2
       + (t3 - t2) * m2;
}

vec3 hermiteTangent(float t, vec3 p1, vec3 m1, vec3 p2, vec3 m2) {
  float t2 = t * t;
  return (6.0 * t2 - 6.0 * t) * p1
       + (3.0 * t2 - 4.0 * t + 1.0) * m1
       + (-6.0 * t2 + 6.0 * t) * p2
       + (3.0 * t2 - 2.0 * t) * m2;
}

void main() {
  float bias = position.y;
  vec2 u = normalize(position.xz);

  vec3 pos = hermitePoint(bias, aStartPoint, aStartTangent, aEndPoint, aEndTangent);
  vec3 tangent = normalize(hermiteTangent(bias, aStartPoint, aStartTangent, aEndPoint, aEndTangent));

  // flip-free reference frame from the averaged start/end binormals
  vec3 startBinormal = normalize(cross(aStartTangent, aStartNormal));
  vec3 endBinormal = normalize(cross(aEndTangent, aEndNormal));
  vec3 referenceBinormal = startBinormal + endBinormal;
  referenceBinormal -= dot(referenceBinormal, tangent) * tangent;
  referenceBinormal = normalize(referenceBinormal);
  vec3 referenceNormal = normalize(cross(referenceBinormal, tangent));

  vec3 local = pos + uRadius * (referenceBinormal * u.x + referenceNormal * u.y);
  vNormal = normalize(mat3(modelMatrix) * (referenceBinormal * u.x + referenceNormal * u.y));

  gl_Position = projectionMatrix * viewMatrix * modelMatrix * vec4(local, 1.0);
}
