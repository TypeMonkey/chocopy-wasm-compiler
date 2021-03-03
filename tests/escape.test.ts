import { parse } from '../parser';
import { tc, defaultTypeEnv } from '../type-check';
import { flattenStmts } from '../lower';
import * as flow from '../flow-escape';
import * as noflow from '../escape';
import { Stmt } from '../ir';
import { Type } from '../ast';
import { expect } from 'chai';

function getEscapers(s : string, analysis: (stmts : Array<Stmt<Type>>) => Array<boolean>) : [Array<Stmt<Type>>, Array<boolean>, Set<string>] {
  const prog = `
  class C(object):
    x : int = 0
  ` + s;
  const parsed = parse(prog);
  const tced = tc(defaultTypeEnv, parsed);
  const flattened = flattenStmts(tced[0].funs[0].body);
  const escapers = analysis(flattened);
  const escapingvars : Set<string> = new Set();
  flattened.forEach((s, i) => {
    // The check for tag === "assign" is redundant, but typescript doesn't know that
    if(escapers[i] && s.tag === "assign") {
      escapingvars.add(s.name + "@" + i);
    }
  })
  return [flattened, escapers, escapingvars];
}

describe("escape", function () {
  it("should recognize reassignments in straight-line code with flows, but not without", function() {
    const source = `
  def f() -> C:
    x: C = None
    y: C = None
    x = C()
    y = C()
    x = y
    return x`;
    const [, , ev1] = getEscapers(source, flow.markEscapers);
    const [, , ev2] = getEscapers(source, noflow.markEscapers);
    expect(ev1).to.deep.equals(new Set(["y@1"]));
    console.log("answer: ", ev2);
    expect(ev2).to.deep.equals(new Set(["x@0", "y@1"]));
  });

  it("should recognize reassignments in loops that affect outer variables", function() {
    const source = `
  def f() -> C:
    obj: C = None
    y: C = None
    obj = C()
    y = obj
    while obj.x < 10:
      obj = C()
      y.x = y.x + 1
      obj.x = y.x
    return y`;
    const [, , ev1] = getEscapers(source, flow.markEscapers);
    const [, , ev2] = getEscapers(source, noflow.markEscapers);
    expect(ev1).to.deep.equals(new Set(["obj@0"]));
    expect(ev2).to.deep.equals(new Set(["obj@0", "obj@5"]));
  });
  it("should recognize reassignments in loops that affect outer variables", function() {
    const source = `
  def f() -> C:
    obj: C = None
    y: C = None
    obj = C()
    y = obj
    while obj.x < 10:
      obj = C()
      y.x = y.x + 1
      obj.x = y.x
      return obj
    return y`;
    // The obj = C() line in the loop is line 5 after lowering/flattening, so obj@5
    const [, , ev1] = getEscapers(source, flow.markEscapers);
    const [, , ev2] = getEscapers(source, noflow.markEscapers);
    // Why does the next line include obj@0?
    expect(ev1).to.deep.equals(new Set(["obj@0", "obj@5"]));
    expect(ev2).to.deep.equals(new Set(["obj@0", "obj@5"]));
  });
})