let gaussian = require('gaussian')
let seedrandom = require('seedrandom')
let stdev = require('standard-deviation')
let { connect } = require('socket.io-client')
let { EventEmitter } = require('events')

module.exports = function (opts = {}) {
  let worker = new EventEmitter()
  let { master, fitness, initialParameters } = opts
  let { sample, getNoiseIndex } = noise(0, Math.floor(Math.random() * 10000000000), initialParameters.length)
  let socket = connect(master)
  socket.on('disconnect', process.exit)
  let sigma = 0.1
  let alpha = 0.01

  let blockGradient = _getBlockGradient.bind(null, initialParameters.length, sample)
  let applyUpdate

  // snapshot of the best parameters so far. this is what we add noise to before evaluating fitness.
  let headParameters = initialParameters.slice()

  let updateVector = Array(initialParameters.length).fill(0)

  socket.on('initialize', ({hyperparameters, blocks}) => {
    sigma = hyperparameters.sigma
    alpha = hyperparameters.alpha
    applyUpdate = _applyUpdate.bind(null, sigma, alpha)
    blocks.forEach(block => {
      let gradient = blockGradient(block)
      addVeci(updateVector, gradient)
    })
    applyUpdate(headParameters, updateVector)
    worker.emit('ready')
  })

  socket.on('block', block => {
    let gradient = blockGradient(block)
    addVeci(updateVector, gradient)
    applyUpdate(headParameters, updateVector)
  })

  worker.on('ready', () => {
    // ready to start an episode
    // generate some trial parameters
    let noiseIndex = getNoiseIndex()
    let noiseVector = sample(noiseIndex)
    // add the head parameters to the noise vector
    let trialParameters = noiseVector
    addVeci(trialParameters, headParameters)
    // now evaluate the fitness of the trial parameters
    fitness(trialParameters, (reward) => {
      // this is the reportFitness callback.
      // tell master how these parameters (noiseIndex) scored
      socket.emit('episode', { noiseIndex, reward })
      // now do it again!
      worker.emit('ready')
    })
  })
}

function addVeci (a, b) {
  // add b to a in-place
  b.forEach((v, k) => {
    a[k] += v
  })
}

function _applyUpdate (sigma, alpha, params, updateVector) {
  // adds updateVector to params in-place, then zeros updateVector
  params.forEach((p, k) => {
    params[k] += updateVector[k] * sigma * alpha
    updateVector[k] = 0
  })
}

function _getBlockGradient (numParams, sample, block) {
  let rewards = block.map(ep => ep.reward)
  let mean = rewards.reduce((a, b) => a + b) / rewards.length
  let std = stdev(rewards) || 0.000001
  let normalizedReturns = rewards.map((r, k) => (r - mean) / std)

  let gradients = Array(numParams).fill(0)
  block.forEach(({reward, noiseIndex}, k) => {
    // reconstruct the perturbation from the noise index
    let noiseVector = sample(noiseIndex, numParams)
    // multiply it by the normalized return
    let gradient = noiseVector.map(v => v * normalizedReturns[k])
    // add gradient to the update buffer, applied at end of episode
    gradient.forEach((grad, index) => {
      gradients[index] += grad
    })
  })

  return gradients
}

function noise (sharedSeed, uniqueSeed, numParams) {
  let distribution = gaussian(0, 1) // standard normal

  return {
    sample (index) {
      let noiseVector = []
      for (let i = 0; i < numParams; i++) {
        noiseVector.push(distribution.ppf(seedrandom(sharedSeed + i + index)()))
      }
      return noiseVector
    },

    getNoiseIndex () {
      return Math.floor(Math.random() * 100000000) + uniqueSeed
    }
  }
}