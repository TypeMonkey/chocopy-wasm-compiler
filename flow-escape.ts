import { merge } from 'cypress/types/lodash';
import { skipPartiallyEmittedExpressions } from 'typescript';
import {Stmt, Value, Expr} from './ir';
import * as util from 'util';

// A reference escapes if it is
// - assigned into a structure (that also escapes)
// - assigned into a global variable
// - used as an argument to a function or method call
// - used as a self parameter in a method call
// - returned

// We assume that this happens _after_ ref-cell wrapping, inlining, and lifting
// functions to the toplevel. So nonlocal variable updates

type Val =
  | { tag: "memloc", line: number}
  | { tag: "prim"}
  | { tag: "anyval" }

  // Since we will use Set to represent abstract values stored in a variable, we
  // need === to work, so cache memloc abstract values for identity.
const mems : Array<Val> = [];
function MEM(n : number) : Val {
  if(!(mems[n])) { mems[n] = { tag: "memloc", line: n }; }
  return mems[n];
}
const PRIM : Val = {tag: "prim"};
const ANY : Val = {tag: "anyval"};

type AbstractEnv = Map<string, Set<Val>>;

// Add all of s2 to s1, report how many additions
function union<E>(s1 : Set<E>, s2 : Set<E>) : number {
  const sizeBefore = s1.size;
  s2.forEach(e => s1.add(e));
  return s1.size - sizeBefore;
}

// Calculate a mapping from assigned names to sets of locations of construct
// expressions they may hold, AT EACH PROGRAM LOCATION. This may be useful in
// other analyses as well.
export function calculateEnvironment<A>(stmts : Array<Stmt<A>>) : Array<AbstractEnv> {
  const envs : Array<AbstractEnv> = new Array(stmts.length).fill(null).map(_ => new Map());
  var sawChangeThisRound = false;
  function indexOf(lbl : string) : number {
    return stmts.findIndex(s => {
      return s.tag === "label" && s.name === lbl;
    });
  }
  function replace(i : number, varname : string, toReplace : Set<Val>) {
    if(!envs[i].has(varname)) {
      envs[i].set(varname, new Set());
    }
    let replaced = false;
    toReplace.forEach(v => {
      if(!(envs[i].get(varname).has(v))) {
        replaced = true;
      }
    });
    if(replaced) {
      console.log("replacing", i, varname, toReplace, envs[i].get(varname));
      sawChangeThisRound = true;
    }
    envs[i].set(varname, new Set(toReplace));
  }
  function update(i : number, varname : string, toAdd : Set<Val>) {
    if(!envs[i].has(varname)) {
      envs[i].set(varname, new Set());
    }
    const added = union(envs[i].get(varname), toAdd);
    if(added > 0) {
      console.log("adding", i, added, toAdd, varname, envs[i].get(varname));
      sawChangeThisRound = true;
    }
  }
  // Make all the envs from j appear in i
  function merge(i : number, j : number, skip?: string) {
    envs[j].forEach((v, k) => {
      if(k !== skip) {
        update(i, k, v);
      }
    });
  }
  function calculateEnvironment() {
    stmts.forEach((s, i) =>  {
      switch(s.tag) {
        case "jmp": // back edge, don't follow!
          merge(indexOf(s.lbl), i);
          return;
        case "ifjmp":
          merge(indexOf(s.thn), i);
          merge(indexOf(s.els), i);
          return;
        case "assign":
          merge(i + 1, i, s.name);
          replace(i + 1, s.name, vale(envs[i], s.value, i));
          return;
        case "field-assign":
        case "label":
        case "pass":
        case "expr":
          merge(i + 1, i);
          return;
        case "return":
          return;
      }
    });
    envs.forEach(e => {
      console.log(e);
    });
    if(sawChangeThisRound) {
      sawChangeThisRound = false;
      calculateEnvironment();
    }
  }
  calculateEnvironment();

  // What kind of abstract value does this expr *evaluate* to?
  function vale<A>(env : AbstractEnv, e : Expr<A>, n : number) : Set<Val> {
    switch(e.tag) {
      case "construct":
        return new Set([MEM(n)]);
      case "value":
        return val(env, e.value);
      case "call":
      case "lookup":
      case "method-call":
        return new Set([ANY]);
      default:
        return new Set([PRIM]);
    }
  }

  // What kind of abstract value is this expr?
  function val<A>(env : AbstractEnv, v : Value<A>) : Set<Val> {
    switch(v.tag) {
      case "id":
        return env.get(v.name);
      default: return new Set([PRIM]);
    }
  }

  return envs;
}

// Goal: mark each line containing a construct expression as escaping or not,
// which would tell us we can perform an optimization on it
// We could try to add to the annotations on expressions, though this would make
// the implementation significantly longer
export function markEscapers<A>(stmts : Array<Stmt<A>>) : Array<boolean> {

  // Our final goal is to fill in this array, where each index corresponds to a
  // line in stmts, and gets true at each index where a construct expression is
  // present that eventually escapes somewhere
  const allocAtLineEscapes = new Array(stmts.length);

  // First, we calculate an environments
  const envs : Array<AbstractEnv> = calculateEnvironment(stmts);

  stmts.forEach((s, i) => {
    switch(s.tag) {
      case "assign": checkEscape(envs[i], s.value); return;
      case "field-assign": checkEscapeV(envs[i], s.value); return;
      case "return": checkEscapeV(envs[i], s.value); return;
      case "expr": checkEscape(envs[i], s.expr); return;
      case "ifjmp": checkEscape(envs[i], s.cond); return;
      case "jmp":
      case "label":
      case "pass":
        return;
    }
  });

  function checkEscapeV<A>(env : AbstractEnv, v : Value<A>) {
    switch(v.tag) {
      case "id":
        if(env.has(v.name)) {
          env.get(v.name).forEach(loc => {
            switch(loc.tag) {
              case "memloc":
                allocAtLineEscapes[loc.line] = true;
              default:
                return;
            }
          });
        }
      default:
        return;
    }
  }
  function checkEscape<A>(env : AbstractEnv, e : Expr<A>) {
    switch(e.tag) {
      case "call": e.arguments.forEach(a => checkEscapeV(env, a)); return;
      case "method-call":
        e.arguments.forEach(a => checkEscapeV(env, a));
        checkEscapeV(env, e.obj);
        return;
      default:
        break;
    }
  }
  return allocAtLineEscapes;
}