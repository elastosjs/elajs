module.exports = function (grunt) {
  grunt.initConfig({
    pkg: grunt.file.readJSON('package.json'),
    prettier: {
      files: {
        src: ['Gruntfile.js', 'src/**/*.js', 'scripts/**/*.js'],
      },
    },
  })

  grunt.loadNpmTasks('grunt-prettier')
}
