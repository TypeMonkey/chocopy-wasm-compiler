import {Stmt, Value, Expr} from './ir';

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
// expressions they may hold. This may be useful in other analyses as well.
export function calculateEnvironment<A>(stmts : Array<Stmt<A>>) : AbstractEnv {
  const env : AbstractEnv = new Map();
  var sawChangeThisRound = false;
  function update(varname : string, toAdd : Set<Val>) {
    if(!env.has(varname)) {
      env.set(varname, new Set());
    }
    const added = union(env.get(varname), toAdd);
    if(added > 0) { sawChangeThisRound = true; }
  }
  function calculateEnvironment() {
    stmts.forEach((s, i) => {
      switch(s.tag) {
        case "assign":
          update(s.name, vale(env, s.value, i));
        case "field-assign":
        case "ifjmp":
        case "jmp":
        case "label":
        case "pass":
        case "return":
        case "expr":
          return;
      }
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

  return env;
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

  // First, we calculate an environment
  const env : AbstractEnv = calculateEnvironment(stmts);

  stmts.forEach((s, i) => {
    switch(s.tag) {
      case "assign": checkEscape(s.value); return;
      case "field-assign": checkEscapeV(s.value); return;
      case "return": checkEscapeV(s.value); return;
      case "ifjmp":
      case "jmp":
      case "label":
      case "pass":
      case "expr":
        return;
    }
  });

  function checkEscapeV<A>(v : Value<A>) {
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
  function checkEscape<A>(e : Expr<A>) {
    switch(e.tag) {
      case "call": e.arguments.forEach(checkEscapeV); return;
      case "method-call":
        e.arguments.forEach(checkEscapeV);
        checkEscapeV(e.obj);
        return;
      default:
        break;
    }
  }
  return allocAtLineEscapes;
}