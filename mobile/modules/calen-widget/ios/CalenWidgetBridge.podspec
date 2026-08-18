Pod::Spec.new do |s|
  # Named -Bridge to stay distinct from the WidgetKit target's own module
  # (product "CalenWidget", targets/widget) — a shared name makes the app pick
  # up the extension's iOS-17 swiftmodule and the build fails on min-deployment.
  s.name           = 'CalenWidgetBridge'
  s.version        = '1.0.0'
  s.summary        = 'App Group snapshot bridge for the Calen home-screen widget'
  s.description    = 'Writes the decrypted calendar snapshot to the shared App Group container and reloads WidgetKit timelines.'
  s.author         = 'Calen'
  s.homepage       = 'https://householdcalendar.com'
  s.license        = { :type => 'UNLICENSED' }
  s.platforms      = { :ios => '15.1' }
  s.source         = { :git => '' }
  s.static_framework = true

  s.dependency 'ExpoModulesCore'

  s.pod_target_xcconfig = {
    'DEFINES_MODULE' => 'YES',
  }

  s.source_files = '**/*.{h,m,mm,swift}'
end
