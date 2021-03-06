import { action as mobxAction, isObservable } from "mobx"

export type ISerializedActionCall = {
    name: string
    path?: string
    args?: any[]
}

export type IRawActionCall = {
    name: string
    object: any & IComplexValue
    args: any[]
}

export type IMiddleWareHandler = (actionCall: IRawActionCall, next: (actionCall: IRawActionCall) => any) => any

function runRawAction(actioncall: IRawActionCall): any {
    return actioncall.object[actioncall.name].apply(actioncall.object, actioncall.args)
}

function collectMiddlewareHandlers(node: Node): IMiddleWareHandler[] {
    let handlers = node.middlewares.slice()
    let n: Node = node
    // Find all middlewares. Optimization: cache this?
    while (n.parent) {
        n = n.parent
        handlers = handlers.concat(n.middlewares)
    }
    return handlers
}

function runMiddleWares(node: Node, baseCall: IRawActionCall): any {
    const handlers = collectMiddlewareHandlers(node)
    // Short circuit
    if (!handlers.length) return runRawAction(baseCall)

    function runNextMiddleware(call: IRawActionCall): any {
        const handler = handlers.shift() // Optimization: counter instead of shift is probably faster
        if (handler) return handler(call, runNextMiddleware)
        else return runRawAction(call)
    }
    return runNextMiddleware(baseCall)
}

export function createActionInvoker(name: string, fn: Function) {
    const action = mobxAction(name, fn)

    const actionInvoker = function(this: IComplexValue) {
        const adm = getStateTreeNode(this)
        adm.assertAlive()
        if (adm.isRunningAction()) {
            // an action is already running in this tree, invoking this action does not emit a new action
            return action.apply(this, arguments)
        } else {
            // outer action, run middlewares and start the action!
            const call: IRawActionCall = {
                name,
                object: adm.storedValue,
                args: argsToArray(arguments)
            }
            const root = adm.root
            root._isRunningAction = true
            try {
                return runMiddleWares(adm, call)
            } finally {
                root._isRunningAction = false
            }
        }
    }

    // This construction helps producing a better function name in the stack trace, but could be optimized
    // away in prod builds, and `actionInvoker` be returned directly
    return createNamedFunction(name, actionInvoker)
}

function serializeArgument(node: Node, actionName: string, index: number, arg: any): any {
    if (isPrimitive(arg)) return arg
    if (isStateTreeNode(arg)) {
        const targetNode = getStateTreeNode(arg)
        if (node.root !== targetNode.root)
            throw new Error(
                `Argument ${index} that was passed to action '${actionName}' is a model that is not part of the same state tree. Consider passing a snapshot or some representative ID instead`
            )
        return {
            $ref: node.getRelativePathTo(getStateTreeNode(arg))
        }
    }
    if (typeof arg === "function")
        throw new Error(
            `Argument ${index} that was passed to action '${actionName}' should be a primitive, model object or plain object, received a function`
        )
    if (typeof arg === "object" && !isPlainObject(arg) && !Array.isArray(arg))
        throw new Error(
            `Argument ${index} that was passed to action '${actionName}' should be a primitive, model object or plain object, received a ${(arg as any) &&
                (arg as any).constructor
                ? (arg as any).constructor.name
                : "Complex Object"}`
        )
    if (isObservable(arg))
        throw new Error(
            `Argument ${index} that was passed to action '${actionName}' should be a primitive, model object or plain object, received an mobx observable.`
        )
    try {
        // Check if serializable, cycle free etc...
        // MWE: there must be a better way....
        JSON.stringify(arg) // or throws
        return arg
    } catch (e) {
        throw new Error(`Argument ${index} that was passed to action '${actionName}' is not serializable.`)
    }
}

function deserializeArgument(adm: Node, value: any): any {
    if (typeof value === "object") {
        const keys = Object.keys(value)
        if (keys.length === 1 && keys[0] === "$ref") return resolvePath(adm.storedValue, value.$ref)
    }
    return value
}

/**
 * Dispatches an Action on a model instance. All middlewares will be triggered.
 * Returns the value of the last actoin
 *
 * @export
 * @param {Object} target
 * @param {IActionCall} action
 * @param {IActionCallOptions} [options]
 * @returns
 */
export function applyAction(target: IComplexValue, action: ISerializedActionCall): any {
    const resolvedTarget = tryResolve(target, action.path || "")
    if (!resolvedTarget) return fail(`Invalid action path: ${action.path || ""}`)
    const node = getStateTreeNode(resolvedTarget)
    if (!(typeof resolvedTarget[action.name] === "function"))
        fail(`Action '${action.name}' does not exist in '${node.path}'`)
    return resolvedTarget[action.name].apply(
        resolvedTarget,
        action.args ? action.args.map(v => deserializeArgument(node, v)) : []
    )
}

export function onAction(target: IComplexValue, listener: (call: ISerializedActionCall) => void): IDisposer {
    return addMiddleware(target, (rawCall, next) => {
        const sourceNode = getStateTreeNode(rawCall.object)
        listener({
            name: rawCall.name,
            path: getStateTreeNode(target).getRelativePathTo(sourceNode),
            args: rawCall.args.map((arg: any, index: number) => serializeArgument(sourceNode, rawCall.name, index, arg))
        })
        return next(rawCall)
    })
}

import { Node, getStateTreeNode, IComplexValue, isStateTreeNode } from "./node"
import { resolvePath, tryResolve, addMiddleware } from "./mst-operations"
import { fail, isPlainObject, isPrimitive, argsToArray, createNamedFunction, IDisposer } from "../utils"
