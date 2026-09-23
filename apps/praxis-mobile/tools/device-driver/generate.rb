# Generates PraxisDriver.xcodeproj (gitignored): an empty host app plus a UI-test
# bundle that drives another installed app by bundle id. Run through setup.sh,
# which supplies CocoaPods' bundled `xcodeproj` gem.
require 'xcodeproj'

team = ENV.fetch('PRAXIS_DRIVER_TEAM') { abort 'PRAXIS_DRIVER_TEAM is not set.' }
prefix = ENV.fetch('PRAXIS_DRIVER_BUNDLE_PREFIX', 'com.acresweb.praxis')

project = Xcodeproj::Project.new('PraxisDriver.xcodeproj')
app = project.new_target(:application, 'DriverHost', :ios, '16.4')
tests = project.new_target(:ui_test_bundle, 'DriverUITests', :ios, '16.4')
host_group = project.main_group.new_group('DriverHost', 'DriverHost')
app.add_file_references([host_group.new_file('App.swift')])
test_group = project.main_group.new_group('DriverUITests', 'DriverUITests')
tests.add_file_references([test_group.new_file('DriverTests.swift')])
tests.add_dependency(app)

[app, tests].each do |target|
  target.build_configurations.each do |config|
    settings = config.build_settings
    settings['DEVELOPMENT_TEAM'] = team
    settings['CODE_SIGN_STYLE'] = 'Automatic'
    settings['SWIFT_VERSION'] = '5.0'
    settings['GENERATE_INFOPLIST_FILE'] = 'YES'
    settings['IPHONEOS_DEPLOYMENT_TARGET'] = '16.4'
    settings['TARGETED_DEVICE_FAMILY'] = '1'
  end
end
app.build_configurations.each do |config|
  config.build_settings['PRODUCT_BUNDLE_IDENTIFIER'] = "#{prefix}.driver"
  config.build_settings['INFOPLIST_KEY_UILaunchScreen_Generation'] = 'YES'
end
tests.build_configurations.each do |config|
  config.build_settings['PRODUCT_BUNDLE_IDENTIFIER'] = "#{prefix}.driver.uitests"
  config.build_settings['TEST_TARGET_NAME'] = 'DriverHost'
end
project.save

scheme = Xcodeproj::XCScheme.new
scheme.add_build_target(app)
scheme.add_test_target(tests)
scheme.set_launch_target(app)
scheme.save_as('PraxisDriver.xcodeproj', 'DriverUITests', true)
