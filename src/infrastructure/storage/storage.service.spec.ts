import { BadRequestException, ForbiddenException, ServiceUnavailableException } from '@nestjs/common';
import { StorageService } from './storage.service';

describe('StorageService (Cloudinary)', () => {
  const png = Buffer.from([0x89,0x50,0x4e,0x47,0x0d,0x0a,0x1a,0x0a,0x00,0x00,0x00,0x0d]);
  const config = (overrides:Record<string,string>={}) => ({
    get: jest.fn((key:string) => ({
      CLOUDINARY_CLOUD_NAME:'boutica-test',
      CLOUDINARY_API_KEY:'test-api-key',
      CLOUDINARY_API_SECRET:'test-api-secret',
      BETTER_AUTH_URL:'https://boutica.test',
      ...overrides,
    } as Record<string,string>)[key]),
  });
  afterEach(()=>jest.restoreAllMocks());

  it('returns a tenant-scoped upload ticket and Cloudinary delivery URL',async()=>{
    const service=new StorageService(config() as any);
    const result=await service.getPresignedUploadUrl('biz-123','products','phone.png','image/png',png.length);
    expect(result.key).toMatch(/^businesses\/biz-123\/products\//);
    expect(result.uploadUrl).toContain('/api/v1/media/upload?key=');
    expect(result.downloadUrl).toContain('res.cloudinary.com/boutica-test/image/upload/');
  });

  it('uploads a validated image using a signed Cloudinary API request',async()=>{
    const service=new StorageService(config() as any);
    const fetchMock=jest.spyOn(globalThis,'fetch').mockImplementation(async(input,init)=>{
      const form=init?.body as FormData;
      expect(form.get('api_key')).toBe('test-api-key');
      expect(form.get('signature')).toEqual(expect.any(String));
      expect(String(input)).toContain('/image/upload');
      return new Response(JSON.stringify({
        public_id:'businesses/biz-123/products/item.png',
        secure_url:'https://res.cloudinary.com/boutica-test/image/upload/v1/item.png',
        bytes:png.length,
      }),{status:200,headers:{'content-type':'application/json'}});
    });
    const result=await service.uploadDirect('biz-123','products','item.png',png,'image/png','businesses/biz-123/products/item.png');
    expect(result.key).toBe('businesses/biz-123/products/item.png');
    expect(result.url).toContain('res.cloudinary.com');
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it('rejects keys belonging to another tenant',async()=>{
    const service=new StorageService(config() as any);
    await expect(service.getPresignedDownloadUrl('biz-attacker','businesses/biz-victim/products/a.png')).rejects.toThrow(ForbiddenException);
  });

  it('rejects MIME spoofing before making a Cloudinary request',async()=>{
    const service=new StorageService(config() as any);
    const fetchMock=jest.spyOn(globalThis,'fetch');
    await expect(service.uploadDirect('biz-123','products','fake.png',Buffer.from('not an image'),'image/png')).rejects.toThrow(BadRequestException);
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it('rejects uploads when Cloudinary credentials are absent',async()=>{
    const service=new StorageService(config({CLOUDINARY_CLOUD_NAME:'',CLOUDINARY_API_KEY:'',CLOUDINARY_API_SECRET:''}) as any);
    await expect(service.getPresignedUploadUrl('biz-123','products','a.png','image/png')).rejects.toThrow(ServiceUnavailableException);
  });

  it('deletes assets through the signed Cloudinary destroy endpoint',async()=>{
    const service=new StorageService(config() as any);
    const fetchMock=jest.spyOn(globalThis,'fetch').mockResolvedValue(new Response(JSON.stringify({result:'ok'}),{status:200,headers:{'content-type':'application/json'}}));
    await expect(service.deleteFile('biz-123','businesses/biz-123/products/a.png')).resolves.toEqual({success:true});
    expect(String(fetchMock.mock.calls[0]?.[0])).toContain('/image/destroy');
  });
});
