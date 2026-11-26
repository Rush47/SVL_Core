import test from 'node:test';
import assert from 'node:assert/strict';
import { extractSelfAvatarAction, findSelfAvatars, downloadSelfAvatar } from './avatarSelf.ts';
test('avatar action is optional, separate, and cannot target another profile',()=>{
  assert.deepEqual(extractSelfAvatarAction('Hello'),{text:'Hello',args:undefined});
  const action=extractSelfAvatarAction('Hello\n<svl_avatar>{"query":"portrait"}</svl_avatar>');
  assert.equal(action.text,'Hello');assert.equal(action.args?.query,'portrait');
  assert.equal(extractSelfAvatarAction('<svl_avatar>{"query":"portrait","agent":"Operator"}</svl_avatar>').args,undefined);
});
test('Commons search needs no Gemini and excludes nonlicensed results',async()=>{
  const found=await findSelfAvatars({query:'portrait'},async url=>{
    assert.equal(new URL(String(url)).hostname,'commons.wikimedia.org');
    return Response.json({query:{pages:{1:{title:'File:Portrait.jpg',imageinfo:[{thumburl:'https://upload.wikimedia.org/portrait.jpg',extmetadata:{LicenseShortName:{value:'CC BY 4.0'},Artist:{value:'Author'}}}]}}}});
  });
  assert.equal(found.length,1);
  const image=await downloadSelfAvatar(found[0],async()=>new Response(new Uint8Array([255,216,255,1,2,3])));
  assert.match(image,/^data:image\/jpeg;base64,/);
  await assert.rejects(downloadSelfAvatar(found[0],async()=>new Response('<html>not image</html>')));
  await assert.rejects(findSelfAvatars({imageUrl:'https://127.0.0.1/test'}));
});
