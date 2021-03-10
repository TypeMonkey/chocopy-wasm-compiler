import { run } from "./runner";
import { GlobalTable, tc } from "./type-check";
import { Value, Type, typeToString, Program } from "./ast";
import { parse } from "./parser";
import { builtinModules } from "module";
import { attachPresenter, BuiltInModule, gatherPresenters, NativeTypes, OtherModule } from "./builtins/builtins";
import { type } from "cypress/types/jquery";
import { ModulePresenter, ClassPresenter, FuncIdentity, idenToStr } from "./types";
import { last, thru, values } from "cypress/types/lodash";
import { NONE } from "./utils";
import fs from 'fs';
import { MainAllocator } from "./heap";
import { compile, LabeledClass, LabeledModule } from "./compiler";

class Labeler {

  labeledBuiltIns: Map<string, LabeledModule>;
  curGVarIndex: number;

  takenLabels: Map<string, number>;

  constructor(){
    this.labeledBuiltIns = new Map();
    this.curGVarIndex = 0;
    this.takenLabels = new Map();
  }

  /**
   * Labels all buillin modules avaiable to this REPL
   */
  init(bmods: Map<string, BuiltInModule>){
    let modCode = 1; //we reserve 0 for the source module

    for(let mod of bmods.values()){
      console.log(`=============LABELING BUILTIN ${mod.name}`);
      this.labeledBuiltIns.set(mod.name, this.label(modCode, mod.presenter, false));
      modCode++;
    }
  }

  labelClass(typeCode: number, presenter: ClassPresenter, hostModule: string): LabeledClass{
    const vars = new Map<string, number>();
    const methods = new Map<string, {identity: FuncIdentity, label: string}>();

    const instanceVars = new Map<string, number>();
    let inVarIndex = 0;
    for(let name of presenter.instanceVars.keys()){
      vars.set(name, inVarIndex);
      inVarIndex++;
    }

    for(let m of presenter.instanceMethods.values()){
      const fName = m.signature.name;
      const label = this.genLabel(`${hostModule}_${presenter.name}_${fName}`);
      methods.set(idenToStr(m), {identity: m, label: label});
    }

    return {typeCode: typeCode, varIndices: vars, methods: methods};
  }

  label(modCode: number, module: ModulePresenter, isSource: boolean): LabeledModule{
    let vIndex = isSource ? this.curGVarIndex : 0;

    const vars = new Map<string, number>();
    for(let name of module.moduleVars.keys()){
      vars.set(name, vIndex);
      vIndex++;
    }

    const funcs = new Map<string, {identity: FuncIdentity, label: string}>();
    for(let f of module.functions.values()){
      const fName = f.signature.name;
      const label = this.genLabel(`${module.name === undefined ? "" : module.name}_${fName}`);
      console.log(`  ** FOR FUNC ${idenToStr(f)}, the label is ${label}`);
      funcs.set(idenToStr(f), {identity: f, label: label});
    }

    const classes = new Map<string, LabeledClass>();
    let typeCode = 0;
    for(let c of module.classes.values()){
      const lclass = this.labelClass(typeCode, c, module.name === undefined ? "" : module.name);
      classes.set(c.name, lclass);
      typeCode++;
    }

    
    return {moduleCode: modCode, classes: classes, funcs: funcs, globalVars: vars};
  }

  genLabel(label: string): string{
    if(this.takenLabels.has(label)){
      const currAddOn = this.takenLabels.get(label);
      this.takenLabels.set(label, currAddOn + 1);
      return label+(currAddOn + 1);
    }
    this.takenLabels.set(label, 0);
    return label;
  }
}

export type Config = {
  builtIns: Map<string, BuiltInModule>,
  builtInPresenters: Map<string, ModulePresenter>,
  allocator: MainAllocator;
  funcs: any
}

export class BasicREPL {
  
  private config: Config;
  private labeler: Labeler;

  private currentTable: GlobalTable;

  constructor(config: Config) {
    this.config = config;

    this.labeler = new Labeler();
    this.labeler.init(config.builtIns);
  }
  
  async run(source: string): Promise<Value> {
    source += "from natives import print, abs, min, max, pow \n"

    const parsed = parse(source);
    const typed = tc(this.currentTable === undefined ? 
                          undefined :  
                          this.currentTable, this.config.builtInPresenters, parsed);
    this.currentTable = typed.table;

    
    const labeled = this.labeler.label(0, typed.typed.presenter, true);
    const compiled = compile(typed.typed, labeled, this.labeler.labeledBuiltIns, this.config.allocator);
    console.log("---------INSTRS--------\n"+compiled.join("\n"));

    
    run(compiled.join("\n"), this.config.funcs);
    

    return undefined;
  }

  async tc(source: string): Promise<Type> {
    source += "from natives import print, abs, min, max, pow \n"

    const parsed = parse(source);
    const typed = tc(this.currentTable === undefined ? 
                          undefined :  
                          this.currentTable, this.config.builtInPresenters, parsed);
    const lastStmt = typed.typed.stmts[typed.typed.stmts.length - 1];

    //console.log(` LAST STMT , is expr? ${lastStmt.tag} ${JSON.stringify(lastStmt)}`);
    if(lastStmt.tag === "expr"){
      return lastStmt.a;
    }
    return NONE;
  }


}

async function main(){
  const allocator = new MainAllocator();
  allocator.init(new Map());

  const builtins = new Map<string, BuiltInModule>();

  const otherModule: OtherModule = new OtherModule(allocator);
  const natives: NativeTypes = new NativeTypes(allocator);
  attachPresenter(otherModule);
  attachPresenter(natives);

  builtins.set(otherModule.name, otherModule);
  builtins.set(natives.name, natives);

  const testFuncs = {
    natives: {
      natives_print: (...args: number[]) => natives.print(...args),
      natives_abs: (...args: number[]) => natives.abs(...args),
      natives_min: (...args: number[]) => natives.min(...args),
      natives_max: (...args: number[]) => natives.max(...args),
      natives_pow: (...args: number[]) => natives.pow(...args)
    },
    otherModule: {
      otherModule_someFunc: (...args: number[]) => otherModule.someFunc(),
      otherModule_otherFunc: (...args: number[]) => otherModule.otherFunc()
    },
    system: {
      instanciate: (code: number) => allocator.allocObj(0, code),
      objderef: (addr: number, index: number) => allocator.objRetr(addr, index),
      objmute: (addr: number, index: number, val: number) => allocator.objMutate(addr, index, val),
      modRef: (modCode: number, varIndex: number) => allocator.modVarRetr(modCode, varIndex),
      modMute: (modCode: number, index: number, val: number) => allocator.modVarMute(modCode, index, val),

      getInt: (addr: number) => allocator.getInt(addr),
      getBool: (addr: number) => allocator.getBool(addr),
      allocInt: (val: number) => allocator.allocInt(val),
      allocBool: (val: number) => allocator.allocBool(val)
    }
  };

  const repl = new BasicREPL({builtIns: builtins, 
                              builtInPresenters: gatherPresenters(builtins), 
                              allocator: allocator,
                              funcs: testFuncs});

  const input = fs.readFileSync("./sampleprogs/sample7.txt","ascii");
  let v = await repl.run(input);
  
  //console.log("last type: "+typeToString(v));

  /*
  var stdin = process.openStdin();
  stdin.addListener("data", async function(d) {
      // note:  d is an object, and when converted to a string it will
      // end with a linefeed.  so we (rather crudely) account for that  
      // with toString() and then substring() 
      const code = d.toString().trim();
      console.log("you entered: [" + code + "]");
      let v = await repl.run(code);
      console.log("       ===> result "+v.tag);
  });
  */
 
}

main();