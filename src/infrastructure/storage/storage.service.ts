import { BadRequestException, ForbiddenException, Injectable, InternalServerErrorException, Logger, NotFoundException, ServiceUnavailableException } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { createHash, randomUUID } from 'crypto';
import type { Env } from '../../config/env.schema';

export const ALLOWED_MIME_TYPES = ['image/jpeg','image/png','image/webp','image/gif','application/pdf','text/csv'] as const;
export type AllowedMimeType = (typeof ALLOWED_MIME_TYPES)[number];
export const MAX_FILE_SIZE_BYTES = 10 * 1024 * 1024;
const MIME_EXTENSION_MAP: Record<string,string> = {'.jpg':'image/jpeg','.jpeg':'image/jpeg','.png':'image/png','.webp':'image/webp','.gif':'image/gif','.pdf':'application/pdf','.csv':'text/csv'};
const IMAGE_TYPES = new Set(['image/jpeg','image/png','image/webp','image/gif']);
const BUSINESS_ID = /^[a-zA-Z0-9_-]+$/;
const FOLDER = /^[a-zA-Z0-9_-]+$/;

@Injectable()
export class StorageService {
  private readonly logger = new Logger(StorageService.name);
  private readonly cloudName?: string;
  private readonly apiKey?: string;
  private readonly apiSecret?: string;
  private readonly publicBaseUrl: string | null;

  constructor(private readonly config?: ConfigService<Env, true>) {
    this.cloudName = this.config?.get?.('CLOUDINARY_CLOUD_NAME' as any,{infer:true});
    this.apiKey = this.config?.get?.('CLOUDINARY_API_KEY' as any,{infer:true});
    this.apiSecret = this.config?.get?.('CLOUDINARY_API_SECRET' as any,{infer:true});
    const base = this.config?.get?.('BETTER_AUTH_URL' as any,{infer:true});
    this.publicBaseUrl = base ? base.replace(/\/+$/,'') : null;
    if (this.configured) this.logger.log('Cloudinary media storage configured.');
    else this.logger.warn('Cloudinary is not configured; media uploads are disabled.');
  }

  get configured(): boolean { return Boolean(this.cloudName && this.apiKey && this.apiSecret); }
  private ensureConfigured(): void {
    if (!this.configured) throw new ServiceUnavailableException('Le stockage Cloudinary n’est pas configuré');
  }
  private validateBusinessId(id: string): void {
    if (!id || !BUSINESS_ID.test(id)) throw new BadRequestException('Identifiant entreprise invalide');
  }
  private validateFolder(folder = 'general'): string {
    const clean = folder.trim();
    if (!FOLDER.test(clean)) throw new BadRequestException('Nom de dossier invalide');
    return clean;
  }
  private sanitizeFilename(name: string): string {
    const base = name.split(/[\\/]/).pop() || 'file';
    return base.normalize('NFKD').replace(/[\u0300-\u036f]/g,'').replace(/[^a-zA-Z0-9._-]/g,'-').replace(/-+/g,'-').slice(0,100) || 'file';
  }
  private extension(name: string): string { const i=name.lastIndexOf('.'); return i<0?'':name.slice(i).toLowerCase(); }
  private buildKey(businessId: string, folder: string, filename: string): string {
    this.validateBusinessId(businessId);
    return `businesses/${businessId}/${this.validateFolder(folder)}/${randomUUID()}-${this.sanitizeFilename(filename)}`;
  }
  private validateKey(businessId: string, key: string): string {
    this.validateBusinessId(businessId);
    let decoded: string;
    try { decoded=decodeURIComponent(key); } catch { throw new BadRequestException('Clé de média malformée'); }
    if (!decoded || decoded.includes('\\') || decoded.includes('\0') || decoded.startsWith('/') ||
      decoded.split('/').some(p=>!p || p==='.' || p==='..') || !decoded.startsWith(`businesses/${businessId}/`)) {
      throw new ForbiddenException('Accès refusé : le média ne appartient pas à votre entreprise');
    }
    return decoded;
  }
  private resourceType(mimeOrKey: string): 'image'|'raw' {
    if (IMAGE_TYPES.has(mimeOrKey)) return 'image';
    const mime=MIME_EXTENSION_MAP[this.extension(mimeOrKey)];
    return mime && IMAGE_TYPES.has(mime) ? 'image':'raw';
  }
  private deliveryUrl(type:'image'|'raw',key:string): string {
    this.ensureConfigured();
    return `https://res.cloudinary.com/${this.cloudName}/${type}/upload/${key.split('/').map(encodeURIComponent).join('/')}`;
  }
  private sign(params: Record<string,string|number|boolean>): string {
    this.ensureConfigured();
    const canonical=Object.keys(params).sort().map(k=>`${k}=${params[k]}`).join('&');
    return createHash('sha1').update(canonical+this.apiSecret).digest('hex');
  }
  private validateMimeType(mime:string): void {
    if (!ALLOWED_MIME_TYPES.includes(mime as AllowedMimeType)) throw new BadRequestException('Format non autorisé. Formats acceptés : JPEG, PNG, WEBP, GIF, PDF et CSV.');
  }
  private validateSize(size:number): void {
    if (!Number.isFinite(size)||size<=0||size>MAX_FILE_SIZE_BYTES) throw new BadRequestException('Taille de fichier invalide (maximum 10 Mo).');
  }
  validateFileSignature(buffer:Buffer,mime:string):void {
    if(!buffer?.length) throw new BadRequestException('Buffer de fichier vide');
    let valid=false;
    switch(mime) {
      case 'image/jpeg': valid=buffer.length>=3&&buffer[0]===0xff&&buffer[1]===0xd8&&buffer[2]===0xff; break;
      case 'image/png': valid=Buffer.from([137,80,78,71,13,10,26,10]).equals(buffer.subarray(0,8)); break;
      case 'image/gif': valid=['GIF87a','GIF89a'].includes(buffer.toString('ascii',0,6)); break;
      case 'image/webp': valid=buffer.length>=12&&buffer.toString('ascii',0,4)==='RIFF'&&buffer.toString('ascii',8,12)==='WEBP'; break;
      case 'application/pdf': valid=buffer.toString('ascii',0,5)==='%PDF-'; break;
      case 'text/csv':
        try { const value=new TextDecoder('utf-8',{fatal:true}).decode(buffer); valid=!!value.trim()&&!/[\x00-\x08\x0B\x0C\x0E-\x1F]/.test(value); } catch { valid=false; }
        break;
    }
    if(!valid) throw new BadRequestException('Le contenu du fichier ne correspond pas au type MIME déclaré.');
  }

  async getPresignedUploadUrl(businessId:string,folder='products',filename:string,mimeType:string,sizeBytes?:number):Promise<{key:string;uploadUrl:string;downloadUrl:string;publicUrl:string}> {
    this.ensureConfigured(); this.validateBusinessId(businessId); this.validateMimeType(mimeType);
    if(sizeBytes!==undefined) this.validateSize(sizeBytes);
    const key=this.buildKey(businessId,folder,filename);
    const uploadUrl=this.publicBaseUrl?`${this.publicBaseUrl}/api/v1/media/upload?key=${encodeURIComponent(key)}`:`/api/v1/media/upload?key=${encodeURIComponent(key)}`;
    const downloadUrl=this.deliveryUrl(this.resourceType(mimeType),key);
    return {key,uploadUrl,downloadUrl,publicUrl:downloadUrl};
  }

  async uploadDirect(businessId:string,folder:string,filename:string,buffer:Buffer,mimeType:string,expectedKey?:string):Promise<{key:string;url:string;downloadUrl:string;publicUrl:string;size:number}> {
    this.ensureConfigured(); this.validateBusinessId(businessId); this.validateMimeType(mimeType); this.validateSize(buffer.length); this.validateFileSignature(buffer,mimeType);
    const key=expectedKey?this.validateKey(businessId,expectedKey):this.buildKey(businessId,folder,filename);
    const type=this.resourceType(mimeType), timestamp=Math.floor(Date.now()/1000);
    const params={public_id:key,timestamp,overwrite:false,unique_filename:false,use_filename:false};
    const form=new FormData();
    form.append('file',new Blob([new Uint8Array(buffer)],{type:mimeType}),this.sanitizeFilename(filename));
    form.append('api_key',this.apiKey!);
    for(const [k,v] of Object.entries(params)) form.append(k,String(v));
    form.append('signature',this.sign(params));
    let response:Response;
    try { response=await fetch(`https://api.cloudinary.com/v1_1/${this.cloudName}/${type}/upload`,{method:'POST',body:form,signal:AbortSignal.timeout(30000)}); }
    catch(e) { this.logger.error('Cloudinary upload request failed',e instanceof Error?e.stack:undefined); throw new InternalServerErrorException('Impossible de joindre Cloudinary'); }
    const payload=await response.json().catch(()=>({})) as any;
    if(!response.ok||payload.public_id!==key||!payload.secure_url) {
      this.logger.error(`Cloudinary upload failed HTTP ${response.status}: ${payload.error?.message||'invalid response'}`);
      throw new InternalServerErrorException('Cloudinary n’a pas pu enregistrer le média');
    }
    return {key,url:payload.secure_url,downloadUrl:payload.secure_url,publicUrl:payload.secure_url,size:Number(payload.bytes??buffer.length)};
  }

  async getPresignedDownloadUrl(businessId:string,key:string):Promise<string> {
    const safe=this.validateKey(businessId,key); return this.deliveryUrl(this.resourceType(safe),safe);
  }
  async getFile(businessId:string,key:string):Promise<{buffer:Buffer;mimeType:string;filename:string}> {
    const safe=this.validateKey(businessId,key),url=this.deliveryUrl(this.resourceType(safe),safe);
    let response:Response;
    try { response=await fetch(url,{signal:AbortSignal.timeout(20000)}); } catch { throw new InternalServerErrorException('Impossible de récupérer le média depuis Cloudinary'); }
    if(response.status===404) throw new NotFoundException('Le média demandé est introuvable');
    if(!response.ok) throw new InternalServerErrorException('Échec de récupération du média');
    return {buffer:Buffer.from(await response.arrayBuffer()),mimeType:MIME_EXTENSION_MAP[this.extension(safe)]||'application/octet-stream',filename:safe.split('/').pop()||'media'};
  }
  async deleteFile(businessId:string,key:string):Promise<{success:boolean}> {
    this.ensureConfigured();
    const safe=this.validateKey(businessId,key),type=this.resourceType(safe),timestamp=Math.floor(Date.now()/1000);
    const params={public_id:safe,timestamp,type:'upload',invalidate:true};
    const form=new FormData();
    form.append('public_id',safe); form.append('timestamp',String(timestamp)); form.append('type','upload');
    form.append('invalidate','true'); form.append('api_key',this.apiKey!); form.append('signature',this.sign(params));
    let response:Response;
    try { response=await fetch(`https://api.cloudinary.com/v1_1/${this.cloudName}/${type}/destroy`,{method:'POST',body:form,signal:AbortSignal.timeout(20000)}); }
    catch { throw new InternalServerErrorException('Impossible de joindre Cloudinary pour supprimer le média'); }
    const payload=await response.json().catch(()=>({})) as any;
    if(!response.ok||!['ok','not found'].includes(payload.result)) {
      this.logger.error(`Cloudinary delete failed HTTP ${response.status}`);
      throw new InternalServerErrorException('Cloudinary n’a pas pu supprimer le média');
    }
    return {success:true};
  }
}
