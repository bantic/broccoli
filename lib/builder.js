var path = require('path')
var findup = require('findup-sync')
var RSVP = require('rsvp')
var mapSeries = require('promise-map-series')
var apiCompat = require('./api_compat')
var heimdall = require('heimdalljs');


exports.Builder = Builder
function Builder (tree) {
  this.tree = tree
  this.allTreesRead = [] // across all builds
}

function wrapStringErrors(reason) {
  var err

  if (typeof reason === 'string') {
    err = new Error(reason + ' [string exception]')
  } else {
    err = reason
  }

  throw err
}

function summarize(node) {
  return {
    directory: node.directory,
    graph: node,
  }
}

RSVP.EventTarget.mixin(Builder.prototype)

Builder.prototype.build = function (willReadStringTree) {
  var builder = this

  var newTreesRead = []
  var nodeCache = []
  var hasMergedInstantiationStack = false;

  return RSVP.Promise.resolve()
    .then(function () {
      return readAndReturnNodeFor(builder.tree) // call builder.tree.read()
    })
    .then(summarize)
    .finally(appendNewTreesRead)
    .catch(wrapStringErrors)


  function appendNewTreesRead() {
    for (var i = 0; i < newTreesRead.length; i++) {
      if (builder.allTreesRead.indexOf(newTreesRead[i]) === -1) {
        builder.allTreesRead.push(newTreesRead[i])
      }
    }
  }

  // Read the `tree` and return its node, which in particular contains the
  // tree's output directory (node.directory)
  function readAndReturnNodeFor (tree) {
    builder.warnIfNecessary(tree)
    tree = builder.wrapIfNecessary(tree)
    var index = newTreesRead.indexOf(tree)
    if (index !== -1) {

      // Return node from cache to deduplicate `.read`
      if (nodeCache[index].directory == null) {
        // node.directory gets set at the very end, so we have found an as-yet
        // incomplete node. This can happen if there is a cycle.
        throw new Error('Tree cycle detected')
      }
      return RSVP.Promise.resolve(nodeCache[index])
    }

    var cookie = heimdall.start({
      name: getDescription(tree),
      broccoliNode: true,
    });

    var node = new Node(tree, heimdall.current)
    // better to use promises via heimdall.node(description, fn)

    // we don't actually support duplicate trees, as such we should likely tag them..
    // and kill the parallel array structure
    newTreesRead.push(tree)
    nodeCache.push(node)

    var treeDirPromise

    if (typeof tree === 'string') {
      treeDirPromise = RSVP.Promise.resolve()
        .then(function () {
          if (willReadStringTree) willReadStringTree(tree)
          return tree
        })
    } else if (!tree || (typeof tree.read !== 'function' && typeof tree.rebuild !== 'function')) {
      throw new Error('Invalid tree found. You must supply a path or an object with a `.read` (deprecated) or `.rebuild` function: ' + getDescription(tree))
    } else {
      var readTreeRunning = false
      treeDirPromise = RSVP.Promise.resolve()
        .then(function () {
          return tree.read(function readTree (subtree) {
            if (readTreeRunning) {
              throw new Error('Parallel readTree call detected; read trees in sequence, e.g. using https://github.com/joliss/promise-map-series')
            }
            readTreeRunning = true

            return RSVP.Promise.resolve()
              .then(function () {
                return readAndReturnNodeFor(subtree) // recurse
              })
              .then(function (childNode) {
                node.addChild(childNode)
                return childNode.directory
              })
              .finally(function () {
                readTreeRunning = false
              })
          })
        }).catch(function(e) {
          if (!hasMergedInstantiationStack) {
            e.stack = e.stack +  '\n\nThe broccoli plugin was instantiated at: \n' + tree._instantiationStack + '\n\n'
            e.message = 'The Broccoli Plugin: ' + tree + ' failed with:'
            hasMergedInstantiationStack = true
          }
          throw e
        })
        .then(function (dir) {
          if (readTreeRunning) {
            throw new Error('.read returned before readTree finished')
          }

          return dir
        })
    }

    return treeDirPromise
      .then(function (treeDir) {
        cookie.stop();

        if (treeDir == null) throw new Error(tree + ': .read must return a directory')
        node.directory = treeDir
        return node
      })
  }
}

function cleanupTree(tree) {
  if (typeof tree !== 'string') {
    return tree.cleanup()
  }
}

Builder.prototype.cleanup = function () {
  return mapSeries(this.allTreesRead, cleanupTree)
}

Builder.prototype.wrapIfNecessary = function (tree) {
  if (typeof tree.rebuild === 'function') {
    // Note: We wrap even if the plugin provides a `.read` function, so that
    // its new `.rebuild` function gets called.
    if (!tree.wrappedTree) { // memoize
      tree.wrappedTree = new apiCompat.NewStyleTreeWrapper(tree)
    }
    return tree.wrappedTree
  } else {
    return tree
  }
}

Builder.prototype.warnIfNecessary = function (tree) {
  if (process.env.BROCCOLI_WARN_READ_API &&
      (typeof tree.read === 'function' || typeof tree.rebuild === 'function') &&
      !tree.__broccoliFeatures__ &&
      !tree.suppressDeprecationWarning) {
    if (!this.didPrintWarningIntro) {
      console.warn('[API] Warning: The .read and .rebuild APIs will stop working in the next Broccoli version')
      console.warn('[API] Warning: Use broccoli-plugin instead: https://github.com/broccolijs/broccoli-plugin')
      this.didPrintWarningIntro = true
    }
    console.warn('[API] Warning: Plugin uses .read/.rebuild API: ' + getDescription(tree))
    tree.suppressDeprecationWarning = true
  }
}


var nodeId = 0

function Node(tree, heimdall) {
  this.id = nodeId++
  this.subtrees = []
  this.tree = tree
  this.parents = []
  this.__heimdall__ = heimdall;
}

Node.prototype.addChild = function Node$addChild(child) {
  this.subtrees.push(child)
}

Node.prototype.inspect = function() {
  return 'Node:' + this.id +
    ' subtrees: ' + this.subtrees.length
}

Node.prototype.toJSON = function() {
  var description = getDescription(this.tree)
  var subtrees = this.subtrees.map(function(node) {
    return node.id
  })

  return {
    id: this.id,
    description: description,
    instantiationStack: this.tree._instantiationStack,
    subtrees: subtrees,
  }
}


exports.loadBrocfile = loadBrocfile
function loadBrocfile () {
  var brocfile = findup('Brocfile.js', {
    nocase: true
  })

  if (brocfile == null) throw new Error('Brocfile.js not found')

  var baseDir = path.dirname(brocfile)

  // The chdir should perhaps live somewhere else and not be a side effect of
  // this function, or go away entirely
  process.chdir(baseDir)

  var tree = require(brocfile)

  return tree
}


exports.getDescription = getDescription
function getDescription (tree) {
  return (tree && tree.description) ||
    (tree && tree.constructor && tree.constructor !== String && tree.constructor.name) ||
    ('' + tree)
}
