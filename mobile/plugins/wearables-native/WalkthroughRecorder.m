/*
 * React Native registration for WalkthroughRecorder. Each signature must match the @objc
 * selector on the Swift side exactly, or the method silently does not exist at the JS call site.
 */
#import <React/RCTBridgeModule.h>
#import <React/RCTEventEmitter.h>

@interface RCT_EXTERN_MODULE (WalkthroughRecorder, RCTEventEmitter)

RCT_EXTERN_METHOD(startWalk : (NSString *)walkId resolver : (RCTPromiseResolveBlock)resolve rejecter : (RCTPromiseRejectBlock)reject)

RCT_EXTERN_METHOD(captureStill : (RCTPromiseResolveBlock)resolve rejecter : (RCTPromiseRejectBlock)reject)

RCT_EXTERN_METHOD(endWalk : (RCTPromiseResolveBlock)resolve rejecter : (RCTPromiseRejectBlock)reject)

@end
