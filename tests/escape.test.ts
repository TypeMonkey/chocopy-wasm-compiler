import { parse } from '../parser';
import { tc, defaultTypeEnv } from '../type-check';
import { flattenStmts } from '../lower';
import { markEscapers } from '../escape';
import { Stmt } from '../ir';
import { Type } from '../ast';

function getEscapers(s : string) : [Array<Stmt<Type>>, Array<boolean>, Set<string>] {
  const prog = `
  class C(object):
    x : int = 0
  ` + s;
  const parsed = parse(prog);
  const tced = tc(defaultTypeEnv, parsed);
  const flattened = flattenStmts(tced[0].funs[0].body);
  const escapers = markEscapers(flattened);
  const escapingvars : Set<string> = new Set();
  flattened.forEach((s, i) => {
    if(escapers[i] && s.tag === "assign") {
      console.log(i, s);
      escapingvars.add(s.name);
    }
  })
  return [flattened, escapers, escapingvars];
}

describe("escape", function () {
  it("should do something", function() {
    const [a, b, c] = getEscapers(`
  def f() -> C:
    x: C = None
    y: C = None
    y = C()
    x = C()
    x = y
    return y`);
    console.log(a, b, c);
  })
})