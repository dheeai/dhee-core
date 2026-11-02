import {it,expect} from 'vitest';
import {getNodeModulesRoots} from '../../src/dag/ecosystem.js';
it('reads JSON roots without splitting Windows drive letters or commas in paths',()=>{
 const before=process.env.DHEE_NODE_MODULES_DIRS;
 const roots=[String.raw`C:\Program Files\Dhee\node_modules`,'/Users/Example, Name/node_modules'];
 try{process.env.DHEE_NODE_MODULES_DIRS=JSON.stringify(roots);expect(getNodeModulesRoots()).toEqual(roots);}
 finally{if(before===undefined)delete process.env.DHEE_NODE_MODULES_DIRS;else process.env.DHEE_NODE_MODULES_DIRS=before;}
});
