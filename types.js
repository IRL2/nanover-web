/**
 * @typedef {Object} TestTrajectoryData
 * @property {object} topology
 * @property {number[]} topology.elements
 * @property {number[][]} topology.bonds
 * @property {number[][][]} positions 
 */

/**
 * @typedef {Object} TestTrajectoryDataSmall
 * @property {object} topology
 * @property {string} topology.elements
 * @property {string} topology.bonds
 * @property {string[]} positions 
 */

/**
 * @typedef {Object} TestTrajectory
 * @property {object} topology
 * @property {Uint8Array} topology.elements
 * @property {Uint32Array} topology.bonds
 * @property {Float32Array[]} positions 
 */
