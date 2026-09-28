import {describe,it,expect} from 'vitest';
import {normalize,baseString,signature} from '../src/oauth1';
describe('OAuth 1.0a',()=>{
 it('normalizes encoded key-value pairs in order',()=>expect(normalize([['z','a b'],['a','1'],['a','0']])).toBe('a=0&a=1&z=a%20b'));
 it('includes query parameters and strips signature',()=>expect(baseString('GET','https://EXAMPLE.com:443/x?b=2',[['a','1'],['oauth_signature','ignore']])).toBe('GET&https%3A%2F%2Fexample.com%2Fx&a%3D1%26b%3D2'));
 it('matches the E*TRADE published signature vector',async()=>{const params:[string,string][]=[['oauth_consumer_key','c5bb4dcb7bd6826c7c4340df3f791188'],['oauth_token','VbiNYl63EejjlKdQM6FeENzcnrLACrZ2JYD6NQROfVI='],['oauth_timestamp','1344885636'],['oauth_nonce','0bba225a40d1bbac2430aa0c6163ce44'],['oauth_signature_method','HMAC-SHA1']];expect(await signature('GET','https://api.etrade.com/v1/accounts/list',params,'7d30246211192cda43ede3abd9b393b9','XCF9RzyQr4UEPloA+WlC06BnTfYC1P0Fwr3GUw/B0Es=')).toBe('UOnPVdzExTAgHkcGWLLfeTaaMSM=');});
});
